export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const text = await response.text();
  const data = parseJson(text);

  if (!response.ok) {
    const error = data as { error?: string; detail?: string };
    throw new ApiError(error.detail || error.error || "Request failed", response.status, error.detail);
  }

  return data as T;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "Invalid response", detail: text.slice(0, 180) };
  }
}
