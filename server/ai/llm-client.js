import { getToolDefinitions } from '../tools/registry.js';
import { executeTool } from '../tools/executor.js';
import { buildSystemPrompt } from './system-prompt.js';
import { addMessage, getMessages, searchMemories, saveToolResult } from '../memory/store.js';
import config from '../config.js';
import OpenAI from 'openai';

let openaiClient = null;
function sanitizeToolCalls(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map(tc => {
    if (!tc || !tc.function) return tc;
    let sanitizedArgs = tc.function.arguments;
    if (typeof sanitizedArgs === 'string') {
      try {
        JSON.parse(sanitizedArgs);
      } catch (e) {
        sanitizedArgs = JSON.stringify({ _raw_invalid: sanitizedArgs });
      }
    }
    return {
      ...tc,
      function: {
        ...tc.function,
        arguments: sanitizedArgs
      }
    };
  });
}

function getClient() {
  const apiKey = config.api.apiKey || 'sk-placeholder';
  const baseURL = config.api.baseUrl || 'https://api.openai.com/v1';

  if (!openaiClient || openaiClient.baseURL !== baseURL || openaiClient.apiKey !== apiKey) {
    openaiClient = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://phantom.ai',
        'X-Title': 'PHANTOM Security Center',
      }
    });
  }
  return openaiClient;
}

export function resetClient() {
  openaiClient = null;
}

export { getClient };

/**
 * Process a user message: send to LLM with tools, handle tool calls recursively, stream responses.
 * Now supports:
 *  - Unlimited tool iterations (no cap)
 *  - AbortSignal for stopping mid-operation
 *  - Thinking/reasoning token detection
 *  - Live tool output streaming via onToolProgress
 */
export async function processMessage(conversationId, userMessage, sessionContext, onChunk, onToolCall, onToolResult, onError, onThinking, abortSignal, onToolProgress, agentRole = 'default') {
  // Get conversation history
  const history = getMessages(conversationId);

  // Build messages array
  const messages = [
    { role: 'system', content: await buildSystemPrompt(sessionContext, agentRole) },
  ];

  // Determine which model to use based on agent role
  let targetModel = config.api.model;
  if (config.agents?.enabled) {
    if (agentRole === 'planner') targetModel = config.agents.plannerModel;
    if (agentRole === 'executor') targetModel = config.agents.executorModel;
  }

  // Add memory context
  try {
    const relevantMemories = searchMemories(userMessage);
    if (relevantMemories.length > 0) {
      const memoryContext = relevantMemories.map(m => `[${m.category}] ${m.key}: ${m.value}`).join('\n');
      messages.push({
        role: 'system',
        content: `## RELEVANT MEMORIES\n${memoryContext}`,
      });
    }
  } catch (err) {
    console.warn(`[LLMClient] Failed to retrieve memory context:`, err.message);
  }

  // Limit history to last 40 messages to keep context window lean
  const recentHistory = history.slice(-40);

  // Clean up truncated history: ensure we don't start with orphan tool responses
  // and ensure all assistant tool_calls have matching tool responses
  while (recentHistory.length > 0 && recentHistory[0].role === 'tool') {
    recentHistory.shift();
  }

  for (let i = 0; i < recentHistory.length; i++) {
    const msg = recentHistory[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const expectedToolCalls = msg.tool_calls;
      const actualToolResponses = [];
      let j = i + 1;
      while (j < recentHistory.length && recentHistory[j].role === 'tool') {
        actualToolResponses.push(recentHistory[j]);
        j++;
      }

      const hasAllResponses = expectedToolCalls.every(tc => actualToolResponses.some(tr => tr.tool_call_id === tc.id)) &&
                              actualToolResponses.length === expectedToolCalls.length;

      if (!hasAllResponses) {
        delete msg.tool_calls;
        if (!msg.content) {
            msg.content = "[Tool calls omitted due to context window truncation]";
        }
        // Remove any orphaned responses for these tool calls
        recentHistory.splice(i + 1, actualToolResponses.length);
      }
    }
  }

  for (const msg of recentHistory) {
    const m = { role: msg.role, content: msg.content };
    if (msg.tool_calls) m.tool_calls = sanitizeToolCalls(msg.tool_calls);
    if (msg.tool_call_id) {
      m.tool_call_id = msg.tool_call_id;
      m.role = 'tool';
    }
    if (msg.name) m.name = msg.name;
    messages.push(m);
  }

  // Add the new user message
  messages.push({ role: 'user', content: userMessage });
  addMessage(conversationId, { role: 'user', content: userMessage });

  // Pre-fetch tool definitions once (don't re-fetch every loop iteration)
  const tools = getToolDefinitions();
  const client = getClient();

let lastNvidiaCallTime = 0;

async function checkNvidiaRateLimit() {
  const isNvidia = (config.api.baseUrl || '').includes('nvidia') || (config.api.apiKey || '').startsWith('nvapi-');
  if (isNvidia) {
    const minIntervalMs = 1500; // 40 RPM = 60,000ms / 40 = 1,500ms between calls
    const now = Date.now();
    const elapsed = now - lastNvidiaCallTime;
    if (elapsed < minIntervalMs) {
      const waitTime = minIntervalMs - elapsed;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastNvidiaCallTime = Date.now();
  }
}

  // Unlimited tool calling loop — runs until AI stops or abort signal fires
  while (true) {
    // Check if aborted
    if (abortSignal?.aborted) {
      const abortMsg = '[PHANTOM] ⏹ Operation stopped by user.';
      onChunk(abortMsg);
      addMessage(conversationId, { role: 'assistant', content: abortMsg });
      return abortMsg;
    }

    try {
      let response;
      let retries = 0;
      const isNvidia = (config.api.baseUrl || '').includes('nvidia') || (config.api.apiKey || '').startsWith('nvapi-');
      const maxRetries = isNvidia ? 6 : 4;

      while (retries < maxRetries) {
        try {
          await checkNvidiaRateLimit();

          // If planner, strictly forbid raw tool access (tools undefined)
          // The planner delegates to orchestrator/executors.
          const effectiveTools = (agentRole === 'planner') ? undefined : (tools.length > 0 ? tools : undefined);
          const effectiveToolChoice = (agentRole === 'planner') ? undefined : (tools.length > 0 ? 'auto' : undefined);

          response = await client.chat.completions.create({
            model: targetModel,
            messages,
            tools: effectiveTools,
            tool_choice: effectiveToolChoice,
            temperature: config.api.temperature,
            max_tokens: config.api.maxTokens,
            stream: true,
          });
          break; // Success, exit retry loop
        } catch (apiError) {
          if (apiError.status === 429 || apiError.message.includes('429') || apiError.message.includes('ResourceExhausted')) {
            retries++;
            if (retries >= maxRetries) throw apiError;
            const retryDelay = isNvidia ? Math.max(2000, retries * 2000) : Math.pow(2, retries) * 1000;
            console.log(`[PHANTOM] Rate limit hit (429). Retrying in ${retryDelay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            if (abortSignal?.aborted) throw new Error('Operation stopped by user.');
            continue;
          }
          throw apiError;
        }
      }

      let fullContent = '';

      let toolCalls = [];
      let isInThinkBlock = false;

      for await (const chunk of response) {
        // Check abort between chunks
        if (abortSignal?.aborted) {
          const abortMsg = '[PHANTOM] ⏹ Operation stopped by user.';
          onChunk(abortMsg);
          addMessage(conversationId, { role: 'assistant', content: abortMsg });
          return abortMsg;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle reasoning/thinking tokens (DeepSeek, Claude, etc.)
        // Some models send reasoning in a separate field
        if (delta.reasoning_content || delta.reasoning) {
          const thinkText = delta.reasoning_content || delta.reasoning;

          if (onThinking) onThinking(thinkText);
          continue;
        }

        // Handle text content — detect <think> blocks inline
        if (delta.content) {
          let text = delta.content;

          while (text.length > 0) {
            if (!isInThinkBlock) {
              const startIdx = text.indexOf('<think>');
              if (startIdx !== -1) {
                // Text before <think> is content
                if (startIdx > 0) {
                  const contentText = text.substring(0, startIdx);
                  fullContent += contentText;
                  onChunk(contentText);
                }
                isInThinkBlock = true;
                text = text.substring(startIdx + '<think>'.length);
              } else {
                fullContent += text;
                onChunk(text);
                text = '';
              }
            } else {
              const endIdx = text.indexOf('</think>');
              if (endIdx !== -1) {
                // Text before </think> is thinking
                if (endIdx > 0) {
                  const thinkText = text.substring(0, endIdx);
                  if (onThinking) onThinking(thinkText);
                }
                isInThinkBlock = false;
                text = text.substring(endIdx + '</think>'.length);
              } else {
                if (onThinking) onThinking(text);
                text = '';
              }
            }
          }
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        }

        // Check for finish
        if (chunk.choices?.[0]?.finish_reason === 'stop') {
          // Normal completion, save and return
          if (fullContent) {
            addMessage(conversationId, { role: 'assistant', content: fullContent });
          }
          return fullContent;
        }

        if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
          break; // Process tool calls below
        }
      }

      // If we have tool calls, execute them
      if (toolCalls.length > 0) {
        // Save assistant message with tool calls
        const assistantMsg = { role: 'assistant', content: fullContent || null, tool_calls: sanitizeToolCalls(toolCalls) };
        addMessage(conversationId, assistantMsg);
        messages.push(assistantMsg);

        // Execute each tool call
        for (const tc of toolCalls) {
          if (!tc || !tc.function?.name) continue;

          // Check abort before each tool execution
          if (abortSignal?.aborted) {
            const abortMsg = '[PHANTOM] ⏹ Operation stopped by user.';
            onChunk(abortMsg);
            addMessage(conversationId, { role: 'assistant', content: abortMsg });
            return abortMsg;
          }

          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch (e) {
            args = { raw: tc.function.arguments };
          }

          onToolCall({ id: tc.id, name: tc.function.name, args });

          const startTime = Date.now();
          let result;
          try {
            // Pass onToolProgress for live output streaming
            result = await executeTool(tc.function.name, args, (progressText) => {
              if (onToolProgress) onToolProgress({ id: tc.id, name: tc.function.name, text: progressText });
            });
          } catch (e) {
            result = `Error: ${e.message}`;
          }
          const duration = Date.now() - startTime;

          // Truncate very long results
          const maxResultLen = 50000;
          let truncatedResult = result;
          if (typeof result === 'string' && result.length > maxResultLen) {
            truncatedResult = result.substring(0, maxResultLen) + `\n\n... [truncated, ${result.length - maxResultLen} chars omitted]`;
          }

          onToolResult({ id: tc.id, name: tc.function.name, result: truncatedResult });

          // Save tool result
          try {
            saveToolResult(conversationId, tc.function.name, args, truncatedResult, 'success', duration);
          } catch (err) {
            console.error('[Tools] Failed to save tool result to memory:', err.message);
          }

          // Add tool result to messages
          const toolMsg = { role: 'tool', content: truncatedResult, tool_call_id: tc.id, name: tc.function.name };
          addMessage(conversationId, toolMsg);
          messages.push(toolMsg);
        }

        // Continue the loop — let the LLM process tool results
        continue;
      }

      // No tool calls and finish_reason was not explicitly 'stop' (stream ended)
      if (fullContent) {
        addMessage(conversationId, { role: 'assistant', content: fullContent });
      }
      return fullContent;

    } catch (error) {
      // If aborted, don't show as error
      if (abortSignal?.aborted) {
        const abortMsg = '[PHANTOM] ⏹ Operation stopped by user.';
        if (typeof onChunk === 'function') onChunk(abortMsg);
        return abortMsg;
      }
      const errMsg = `⚠️ LLM Error: ${error.message}`;
      if (typeof onError === 'function') onError(errMsg);
      if (typeof onChunk === 'function') {
        onChunk(`\n\n⚠️ **LLM Connection Error**: ${error.message}\n\nPlease check your API key, model selection (\`${targetModel}\`), or Base URL in **Manage (⚙️ Settings)**.`);
      }
      addMessage(conversationId, { role: 'assistant', content: errMsg });
      return errMsg;
    }
  }
}

/**
 * Test API connection
 */
export async function testConnection() {
  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: config.api.model,
      messages: [{ role: 'user', content: 'Say "PHANTOM online" in exactly 2 words.' }],
      max_tokens: 20,
    }, { timeout: 5000 });
    return { success: true, message: response.choices[0]?.message?.content || 'Connected', model: config.api.model };
  } catch (error) {
    return { success: false, message: error.message };
  }
}
