// src/lib/adapters/html-fetch.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchTrackerHtml } from "./html-fetch"

const BASE = {
  url: "https://tracker.example/profile",
  cookies: "uid=1; pass=abc",
  label: "ExampleTracker",
  sessionExpiredMessage: "Session expired. Browser cookies need to be refreshed",
}

function htmlResponse(body: string): Response {
  return { ok: true, status: 200, statusText: "OK", text: async () => body } as Response
}

function redirectResponse(location: string, status = 302): Response {
  return {
    ok: false,
    status,
    statusText: "Found",
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
  } as unknown as Response
}

describe("fetchTrackerHtml - headers", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("sends browser navigation headers only when a User-Agent is supplied", async () => {
    let headers: Record<string, string> | undefined
    vi.spyOn(global, "fetch").mockImplementation((_url, init) => {
      headers = init?.headers as Record<string, string>
      return Promise.resolve(htmlResponse("<html></html>"))
    })

    await fetchTrackerHtml({ ...BASE, userAgent: "Mozilla/5.0 (Test)" })
    expect(headers?.["User-Agent"]).toBe("Mozilla/5.0 (Test)")
    expect(headers?.["Sec-Fetch-Mode"]).toBe("navigate")
    expect(headers?.DNT).toBe("1")

    await fetchTrackerHtml(BASE)
    expect(headers?.["User-Agent"]).toBeUndefined()
    expect(headers?.["Sec-Fetch-Mode"]).toBeUndefined()
    expect(headers?.DNT).toBeUndefined()
  })

  it("always sends the cookie header and an HTML Accept", async () => {
    let headers: Record<string, string> | undefined
    vi.spyOn(global, "fetch").mockImplementationOnce((_url, init) => {
      headers = init?.headers as Record<string, string>
      return Promise.resolve(htmlResponse("<html></html>"))
    })

    await fetchTrackerHtml(BASE)

    expect(headers?.Cookie).toBe("uid=1; pass=abc")
    expect(headers?.Accept).toContain("text/html")
  })

  it("sets a request timeout", async () => {
    let signal: AbortSignal | undefined
    vi.spyOn(global, "fetch").mockImplementationOnce((_url, init) => {
      signal = init?.signal as AbortSignal | undefined
      return Promise.resolve(htmlResponse("<html></html>"))
    })

    await fetchTrackerHtml(BASE)

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })
})

describe("fetchTrackerHtml - redirects", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("treats a 302 as an expired session when redirects are not followed", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(redirectResponse("/login"))

    await expect(fetchTrackerHtml(BASE)).rejects.toThrow("Session expired")
  })

  it("follows a non-login redirect when configured to", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(redirectResponse("/t"))
      .mockResolvedValueOnce(htmlResponse("<html>stats</html>"))

    const html = await fetchTrackerHtml({
      ...BASE,
      followRedirects: { loginPattern: /\/auth\/login|\/login/i },
    })

    expect(html).toBe("<html>stats</html>")
  })

  it("reports an expired session when a followed redirect points at login", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(redirectResponse("/auth/login"))

    await expect(
      fetchTrackerHtml({ ...BASE, followRedirects: { loginPattern: /\/auth\/login|\/login/i } })
    ).rejects.toThrow("Session expired")
  })

  // The headers carry the user's tracker session cookie, and Location is chosen by
  // the remote host, so following it off-origin would hand that cookie to whoever
  // the tracker names. These assert the request is never made, not merely that the
  // call rejects.
  it("refuses to follow a redirect to another host, and sends nothing there", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(redirectResponse("https://attacker.example/collect"))

    await expect(
      fetchTrackerHtml({ ...BASE, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("redirected off-site")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain("attacker.example")
  })

  it("refuses a protocol-relative redirect, which also leaves the origin", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(redirectResponse("//attacker.example/collect"))

    await expect(
      fetchTrackerHtml({ ...BASE, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("redirected off-site")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // A status missing from the redirect set is handed back as though it were the
  // final response, so it never reaches the same-origin check, the guard would
  // be silently narrower than it looks. 307 and 308 preserve the method and are
  // ordinary on CDN-fronted hosts.
  it.each([301, 303, 307, 308])("refuses an off-site redirect sent as %i", async (status) => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(redirectResponse("https://attacker.example/collect", status))

    await expect(
      fetchTrackerHtml({ ...BASE, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("redirected off-site")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain("attacker.example")
  })

  it.each([301, 303, 307, 308])(
    "treats a %i as an expired session when redirects are not followed",
    async (status) => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(redirectResponse("/login", status))

      await expect(fetchTrackerHtml(BASE)).rejects.toThrow("Session expired")
    }
  )

  it("refuses a redirect to a private address", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(redirectResponse("http://127.0.0.1:8080/"))

    await expect(
      fetchTrackerHtml({ ...BASE, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("redirected off-site")

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("still follows a same-origin redirect that changes only the path", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(redirectResponse("https://tracker.example/t?page=2"))
      .mockResolvedValueOnce(htmlResponse("<html>stats</html>"))

    const html = await fetchTrackerHtml({
      ...BASE,
      followRedirects: { loginPattern: /\/login/i },
    })

    expect(html).toBe("<html>stats</html>")
  })

  it("gives up after the hop limit rather than looping", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(redirectResponse("/next"))

    await expect(
      fetchTrackerHtml({
        ...BASE,
        followRedirects: { loginPattern: /\/login/i, maxHops: 2 },
      })
    ).rejects.toThrow("Too many redirects from ExampleTracker")
  })

  it("stops on a redirect with no Location header", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(redirectResponse(""))

    await expect(
      fetchTrackerHtml({ ...BASE, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("Too many redirects from ExampleTracker")
  })
})

describe("fetchTrackerHtml - errors", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("falls back to a tracker-labelled message for an unrecognized status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: { get: () => null },
    } as unknown as Response)

    await expect(fetchTrackerHtml(BASE)).rejects.toThrow("ExampleTracker page fetch failed: 500")
  })

  it("sanitizes an auth failure rather than echoing the status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: { get: () => null },
    } as unknown as Response)

    await expect(fetchTrackerHtml(BASE)).rejects.toThrow("Authentication failed")
  })

  it("classifies a connection failure by hostname", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("fetch failed", { cause }))

    await expect(fetchTrackerHtml(BASE)).rejects.toThrow("tracker.example")
  })
})

// The proxied path used to return the first response directly, so a configured
// proxy silently turned redirect following off: IPTorrents, whose stats page is
// only reachable through the routine / -> /t bounce, could never be read through
// a tunnel. These pin the two paths to the same behaviour.
describe("fetchTrackerHtml - through a proxy", () => {
  const PROXY = { ...BASE, url: "https://tracker.example/", proxyAgent: {} as never }

  function proxyResponse(status: number, { body = "", location = "" } = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 302 ? "Found" : "OK",
      headers: location ? { location } : {},
      buffer: () => Promise.resolve(Buffer.from(body, "utf8")),
    }
  }

  /** Re-imports the module with @/lib/tunnel mocked, since proxyFetch is imported lazily. */
  async function loadWithProxyFetch(proxyFetch: unknown) {
    vi.doMock("@/lib/tunnel", () => ({ proxyFetch }))
    vi.resetModules()
    return (await import("./html-fetch")).fetchTrackerHtml
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.doUnmock("@/lib/tunnel")
    vi.resetModules()
  })

  it("follows a same-origin redirect instead of failing on the 302", async () => {
    const proxyFetch = vi
      .fn()
      .mockResolvedValueOnce(proxyResponse(302, { location: "/t" }))
      .mockResolvedValueOnce(proxyResponse(200, { body: "<html>stats</html>" }))
    const fetchSpy = vi.spyOn(global, "fetch")
    const fetchThroughProxy = await loadWithProxyFetch(proxyFetch)

    const html = await fetchThroughProxy({
      ...PROXY,
      followRedirects: { loginPattern: /\/login/i },
    })

    expect(html).toBe("<html>stats</html>")
    expect(proxyFetch.mock.calls[1][0]).toBe("https://tracker.example/t")
    // A fall-through to fetch() would leave the tunnel and expose the real IP.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports an expired session when the proxied redirect points at login", async () => {
    const proxyFetch = vi.fn().mockResolvedValue(proxyResponse(302, { location: "/login" }))
    const fetchThroughProxy = await loadWithProxyFetch(proxyFetch)

    await expect(
      fetchThroughProxy({ ...PROXY, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("Session expired")
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })

  it("refuses an off-site redirect, and sends nothing there", async () => {
    const proxyFetch = vi
      .fn()
      .mockResolvedValue(proxyResponse(302, { location: "https://attacker.example/collect" }))
    const fetchThroughProxy = await loadWithProxyFetch(proxyFetch)

    await expect(
      fetchThroughProxy({ ...PROXY, followRedirects: { loginPattern: /\/login/i } })
    ).rejects.toThrow("redirected off-site")

    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(String(proxyFetch.mock.calls[0][0])).not.toContain("attacker.example")
  })

  it("treats a redirect as an expired session when redirects are not followed", async () => {
    const proxyFetch = vi.fn().mockResolvedValue(proxyResponse(302, { location: "/login" }))
    const fetchThroughProxy = await loadWithProxyFetch(proxyFetch)

    await expect(fetchThroughProxy(PROXY)).rejects.toThrow("Session expired")
  })

  it("still reports a non-redirect failure with the tracker label", async () => {
    const proxyFetch = vi.fn().mockResolvedValue(proxyResponse(500))
    const fetchThroughProxy = await loadWithProxyFetch(proxyFetch)

    await expect(fetchThroughProxy(PROXY)).rejects.toThrow("ExampleTracker page fetch failed: 500")
  })
})

// Sec-Fetch-Site is a claim about where the request came from, and it changes
// after the first hop. Sending `same-origin` on the opening navigation says a
// page on the site linked here, with no Referer to back it up — a combination no
// browser emits, and one a tracker that fingerprints sessions can refuse.
describe("fetchTrackerHtml - Sec-Fetch-Site coherence", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("opens with Sec-Fetch-Site: none and switches to same-origin on a followed hop", async () => {
    const sites: (string | undefined)[] = []
    vi.spyOn(global, "fetch").mockImplementation((_url, init) => {
      const headers = init?.headers as Record<string, string>
      sites.push(headers["Sec-Fetch-Site"])
      return Promise.resolve(
        sites.length === 1 ? redirectResponse("/t") : htmlResponse("<html>stats</html>")
      )
    })

    await fetchTrackerHtml({
      ...BASE,
      userAgent: "Mozilla/5.0 (Test)",
      followRedirects: { loginPattern: /\/login/i },
    })

    expect(sites).toEqual(["none", "same-origin"])
  })

  it("sends no Sec-Fetch-Site at all without a User-Agent", async () => {
    let headers: Record<string, string> | undefined
    vi.spyOn(global, "fetch").mockImplementationOnce((_url, init) => {
      headers = init?.headers as Record<string, string>
      return Promise.resolve(htmlResponse("<html></html>"))
    })

    await fetchTrackerHtml(BASE)

    expect(headers?.["Sec-Fetch-Site"]).toBeUndefined()
    expect(headers?.["Sec-Fetch-Mode"]).toBeUndefined()
  })
})
