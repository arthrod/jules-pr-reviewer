import * as github from "@actions/github";

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

/**
 * A real Octokit client whose transport records every request and answers with
 * a canned JSON body, so tests can assert on exactly what is sent to GitHub.
 */
export function recordingOctokit(responseBody: object = {}): {
  octokit: ReturnType<typeof github.getOctokit>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    requests.push({
      method: init?.method ?? "GET",
      url: input.toString(),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    octokit: github.getOctokit("test-token", { request: { fetch } }),
    requests,
  };
}
