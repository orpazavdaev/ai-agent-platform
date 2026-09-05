import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LlmConnectionError,
  LlmError,
  LlmModelError,
  OllamaProvider,
} from "../src/llm/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OllamaProvider", () => {
  it("reads model and base URL from environment configuration", () => {
    const provider = OllamaProvider.fromEnv({
      OLLAMA_BASE_URL: "http://127.0.0.1:11434/",
      OLLAMA_MODEL: "qwen2.5-coder",
    });

    expect(provider.baseUrl).toBe("http://127.0.0.1:11434");
    expect(provider.model).toBe("qwen2.5-coder");
  });

  it("returns a provider-neutral chat response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "llama3.2",
        message: {
          role: "assistant",
          content: "The threshold should be inclusive.",
        },
        done: true,
      }),
    );

    const provider = new OllamaProvider({
      model: "llama3.2",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.chat({
      messages: [{ role: "user", content: "Explain the failing test." }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      model: "llama3.2",
      stream: false,
      messages: [{ role: "user", content: "Explain the failing test." }],
    });

    expect(result).toEqual({
      model: "llama3.2",
      done: true,
      message: {
        role: "assistant",
        content: "The threshold should be inclusive.",
      },
    });
  });

  it("maps tool definitions and tool calls when the model supports them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "llama3.2",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "search_code",
                arguments: { query: "applyVolumeDiscount" },
              },
            },
          ],
        },
        done: true,
      }),
    );

    const provider = new OllamaProvider({
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.chat({
      messages: [{ role: "user", content: "Find the discount helper." }],
      tools: [
        {
          name: "search_code",
          description: "Search repository files",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_code",
          description: "Search repository files",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      },
    ]);

    expect(result.message.toolCalls).toEqual([
      {
        id: "tool-call-1",
        name: "search_code",
        arguments: { query: "applyVolumeDiscount" },
      },
    ]);
  });

  it("handles connection failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const provider = new OllamaProvider({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.chat({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(LlmConnectionError);
  });

  it("handles model errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: "model 'missing' not found" }, 404),
    );
    const provider = new OllamaProvider({
      model: "missing",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.chat({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(LlmModelError);
  });

  it("handles empty chat requests as provider errors", async () => {
    const provider = new OllamaProvider({
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  it("exposes a provider-neutral factory for the agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "phi3",
        message: { role: "assistant", content: "ok" },
        done: true,
      }),
    );

    const provider = OllamaProvider.fromEnv(
      {
        OLLAMA_BASE_URL: "http://localhost:11434",
        OLLAMA_MODEL: "phi3",
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    const result = await provider.chat({
      messages: [{ role: "user", content: "ping" }],
    });

    expect(result.message.content).toBe("ok");
    expect(result.model).toBe("phi3");
  });
});
