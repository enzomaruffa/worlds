import { call } from "./http";

export interface ConnectorInfo {
  name: string;
  tools: string[];
}

export interface ToolInfo {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Call an external service (Linear, GitHub, …) through the platform's own credential.
// The browser never sees a key. Which connectors a site may reach, which tools it may
// call, and which arguments are pinned server-side are all operator configuration — a
// site cannot grant itself access, and cannot override a pinned argument.
export const connect = {
  // What this site may reach. Empty (not an error) when nothing is granted, so a page
  // can feature-detect without an error path.
  list: (): Promise<{ items: ConnectorInfo[]; next_cursor: null }> =>
    call("GET", "/api/v1/connect"),

  // The allowed tools and their input schemas, straight from the remote service.
  tools: (name: string): Promise<{ items: ToolInfo[]; next_cursor: null }> =>
    call("GET", `/api/v1/connect/${encodeURIComponent(name)}/tools`),

  // Invoke one tool. Never retried internally — a repeated call would file the issue
  // twice — so a timeout is yours to decide about.
  call: (name: string, tool: string, args: Record<string, unknown> = {}): Promise<any> =>
    call("POST", `/api/v1/connect/${encodeURIComponent(name)}/call`, { tool, args }),
};
