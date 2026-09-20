const AUTH_COOKIE = "infinite_canvas_session";
const UNLOCK_PATH = "/api/site-auth/unlock";
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export async function siteAuthResponse(request: Request, configuredPassword: string | undefined): Promise<Response | null> {
    const password = configuredPassword?.trim();
    if (!password) return null;

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === UNLOCK_PATH) return unlockResponse(request, password);
    if (await hasValidSession(request, password)) return null;

    if (request.method === "GET" && acceptsHtml(request)) return loginPage();
    return Response.json(
        { error: { message: "请先输入访问口令解锁画布", type: "site_locked" } },
        { status: 401, headers: noStoreHeaders() },
    );
}

async function unlockResponse(request: Request, configuredPassword: string) {
    let suppliedPassword = "";
    try {
        const body = (await request.json()) as { password?: unknown };
        suppliedPassword = typeof body.password === "string" ? body.password : "";
    } catch {
        return authJson("请求格式无效", 400);
    }

    if (!(await secretsEqual(suppliedPassword, configuredPassword))) return authJson("口令不正确", 401);

    const expires = Date.now() + SESSION_LIFETIME_MS;
    const token = await signedToken(configuredPassword, expires);
    return Response.json(
        { ok: true },
        {
            headers: {
                ...noStoreHeaders(),
                "Set-Cookie": `${AUTH_COOKIE}=${expires}.${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
            },
        },
    );
}

async function hasValidSession(request: Request, password: string) {
    const raw = readCookie(request.headers.get("cookie"), AUTH_COOKIE);
    if (!raw) return false;
    const separator = raw.indexOf(".");
    if (separator < 1) return false;
    const expiresText = raw.slice(0, separator);
    const expires = Number(expiresText);
    if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
    const expected = await signedToken(password, expires);
    return secretsEqual(raw.slice(separator + 1), expected);
}

async function signedToken(password: string, expires: number) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`infinite-canvas:${expires}`));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretsEqual(left: string, right: string) {
    const [leftHash, rightHash] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(left)),
        crypto.subtle.digest("SHA-256", encoder.encode(right)),
    ]);
    const leftBytes = new Uint8Array(leftHash);
    const rightBytes = new Uint8Array(rightHash);
    let difference = leftBytes.length ^ rightBytes.length;
    for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index]! ^ rightBytes[index]!;
    return difference === 0;
}

function readCookie(header: string | null, name: string) {
    if (!header) return "";
    for (const part of header.split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (key === name) return value.join("=");
    }
    return "";
}

function acceptsHtml(request: Request) {
    return request.headers.get("accept")?.includes("text/html") || request.headers.get("sec-fetch-dest") === "document";
}

function authJson(message: string, status: number) {
    return Response.json({ error: { message, type: "site_auth_error" } }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders() {
    return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

function loginPage() {
    return new Response(
        `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>解锁 AI 无限画布</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f7f7f5; background: radial-gradient(circle at 50% 10%, #34302b 0, #1d1b19 38%, #11100f 75%); }
    main { width: min(100%, 390px); padding: 34px; border: 1px solid rgba(255,255,255,.12); border-radius: 24px; background: rgba(28,26,24,.88); box-shadow: 0 24px 80px rgba(0,0,0,.42); backdrop-filter: blur(18px); }
    .mark { width: 48px; height: 48px; display: grid; place-items: center; margin-bottom: 24px; border-radius: 15px; color: #171513; background: #f2eee8; font-size: 23px; }
    h1 { margin: 0; font-size: 25px; letter-spacing: -.03em; }
    p { margin: 10px 0 24px; color: #aaa39b; font-size: 14px; line-height: 1.6; }
    label { display: block; margin-bottom: 9px; color: #d2ccc4; font-size: 13px; }
    input { width: 100%; height: 48px; padding: 0 15px; border: 1px solid rgba(255,255,255,.14); border-radius: 13px; outline: none; color: #fff; background: rgba(255,255,255,.055); font-size: 18px; letter-spacing: .18em; transition: border-color .2s, box-shadow .2s; }
    input:focus { border-color: #e8e0d5; box-shadow: 0 0 0 3px rgba(232,224,213,.1); }
    button { width: 100%; height: 48px; margin-top: 14px; border: 0; border-radius: 13px; color: #181512; background: #f2eee8; font-size: 15px; font-weight: 650; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    #error { min-height: 20px; margin-top: 12px; color: #ff8888; font-size: 13px; text-align: center; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">✦</div>
    <h1>AI 无限画布</h1>
    <p>这是私人画布。请输入访问口令后继续。</p>
    <form id="unlock-form">
      <label for="password">访问口令</label>
      <input id="password" name="password" type="password" inputmode="numeric" autocomplete="current-password" autofocus required />
      <button id="submit" type="submit">解锁画布</button>
      <div id="error" role="alert"></div>
    </form>
  </main>
  <script>
    const form = document.getElementById("unlock-form");
    const input = document.getElementById("password");
    const button = document.getElementById("submit");
    const error = document.getElementById("error");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      button.disabled = true;
      button.textContent = "正在验证…";
      try {
        const response = await fetch("${UNLOCK_PATH}", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.value })
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error?.message || "验证失败，请重试");
        }
        location.reload();
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : "验证失败，请重试";
        input.select();
      } finally {
        button.disabled = false;
        button.textContent = "解锁画布";
      }
    });
  </script>
</body>
</html>`,
        {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                ...noStoreHeaders(),
                "Content-Security-Policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
                "Referrer-Policy": "no-referrer",
                "X-Frame-Options": "DENY",
            },
        },
    );
}
