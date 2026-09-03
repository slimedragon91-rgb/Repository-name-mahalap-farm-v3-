export interface Env {
  DB?: D1Database;
  FILES?: R2Bucket;
  CACHE?: KVNamespace;
  SESSION_SECRET?: string;
}

const html = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>มหาลาภฟาร์ม V3.0</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:32px;background:#f6f7f4;color:#1f2937}
    .card{background:#fff;border-radius:18px;padding:24px;margin:16px 0;box-shadow:0 4px 18px #0000000d}
    h1{margin-top:0}.tag{display:inline-block;padding:6px 10px;border-radius:999px;background:#e8f5e9}
    code{background:#f1f5f9;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="card">
    <span class="tag">Cloudflare Worker</span>
    <h1>มหาลาภฟาร์ม V3.0</h1>
    <p>ระบบจัดการฟาร์มและสินค้าแบบ Cloudflare-native</p>
    <p>สถานะระบบ: <strong id="status">กำลังตรวจสอบ...</strong></p>
  </div>
  <div class="card">
    <h2>โมดูลหลัก</h2>
    <ul>
      <li>จัดการฟาร์มและสินค้า</li>
      <li>สต็อกและคำสั่งซื้อ</li>
      <li>สมาชิกและสิทธิ์การใช้งาน</li>
      <li>การชำระเงินและจัดส่ง</li>
      <li>บันทึกกิจกรรมและการตรวจสอบย้อนหลัง</li>
    </ul>
  </div>
<script>
fetch('/api/health').then(r=>r.json()).then(x=>{
  document.querySelector('#status').textContent=x.ok?'พร้อมใช้งาน':'มีปัญหา';
}).catch(()=>document.querySelector('#status').textContent='เชื่อมต่อไม่ได้');
</script>
</body>
</html>`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "mahalap-farm-v3",
        runtime: "cloudflare-workers",
        bindings: {
          d1: Boolean(env.DB),
          r2: Boolean(env.FILES),
          kv: Boolean(env.CACHE)
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/api/products") {
      if (!env.DB) {
        return json({ ok: false, error: "D1 is not connected yet" }, 503);
      }
      const result = await env.DB.prepare(
        "SELECT id, name, description, price, stock, unit, status FROM products WHERE status = 'ACTIVE' ORDER BY created_at DESC"
      ).all();
      return json({ ok: true, products: result.results });
    }

    return json({ ok: false, error: "Not Found" }, 404);
  }
} satisfies ExportedHandler<Env>;
