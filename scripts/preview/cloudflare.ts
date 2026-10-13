export class Cloudflare {
  constructor(private account: string, private token: string, private request: typeof fetch = fetch) {
    if (!/^[a-f0-9]{32}$/.test(account) || !token) throw new Error("Invalid Cloudflare account/token configuration");
  }
  async api(path: string, method = "GET", body?: unknown, missingOK = false): Promise<any> {
    const response = await this.request(`https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (missingOK && response.status === 404) return null;
    const data = response.status === 204 ? { success: true } : await response.json() as any;
    if (!response.ok || data.success === false) {
      // Never echo response bodies, which can contain request data or credentials.
      throw new Error(`Cloudflare ${method} failed (${response.status}; codes ${(data.errors ?? []).map((e: any) => e.code).join(",")})`);
    }
    return data;
  }
  async named(path: string, field: string, name: string): Promise<any | undefined> {
    for (let page = 1; page <= 1000; page++) {
      const data = await this.api(`${path}?page=${page}&per_page=100`);
      if (!Array.isArray(data.result)) throw new Error("Invalid Cloudflare resource list");
      const matches = data.result.filter((item: any) => item[field] === name);
      if (matches.length > 1) throw new Error("Ambiguous resource identity");
      if (matches.length === 1) return matches[0];
      // Queue API may return a server-selected page size (e.g. 20) despite per_page=100.
      // A short page is not proof of completion. Prefer metadata, else read until empty.
      if (data.result.length === 0 || typeof data.result_info?.total_pages === "number" && page >= data.result_info.total_pages) return undefined;
    }
    throw new Error("Resource pagination exceeded limit");
  }
}
