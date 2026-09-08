export interface Env {
  DB?: D1Database;
  FILES?: R2Bucket;
  CACHE?: KVNamespace;
  SESSION_SECRET?: string;
}

type AuctionStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "OPEN"
  | "CLOSED"
  | "CANCELLED";

type AdminRole =
  | "GOD_ADMIN"
  | "FARM_ADMIN"
  | "CONTENT_ADMIN"
  | "STAFF";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers":
    "Content-Type,X-User-Id,X-Admin-Role",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

function getUserId(request: Request): string | null {
  const value = request.headers.get("X-User-Id");
  return value?.trim() || null;
}

function getAdminRole(request: Request): AdminRole | null {
  const value = request.headers.get("X-Admin-Role") as AdminRole | null;
  if (
    value === "GOD_ADMIN" ||
    value === "FARM_ADMIN" ||
    value === "CONTENT_ADMIN" ||
    value === "STAFF"
  ) {
    return value;
  }
  return null;
}

function canManageAuctions(request: Request): boolean {
  const role = getAdminRole(request);
  return role === "GOD_ADMIN" || role === "FARM_ADMIN";
}

function canAnnounce(request: Request): boolean {
  const role = getAdminRole(request);
  return (
    role === "GOD_ADMIN" ||
    role === "FARM_ADMIN" ||
    role === "CONTENT_ADMIN"
  );
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function logAdminAction(
  db: D1Database,
  request: Request,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: unknown = null,
): Promise<void> {
  const userId = getUserId(request);

  await db
    .prepare(
      `INSERT INTO audit_logs
       (id, user_id, action, target_type, target_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid(),
      userId,
      action,
      targetType,
      targetId,
      metadata === null ? null : JSON.stringify(metadata),
    )
    .run();
}

async function getAuction(
  db: D1Database,
  auctionId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(
      `SELECT
        a.id,
        a.product_id,
        a.title,
        a.description,
        a.starting_price,
        a.current_price,
        a.minimum_increment,
        a.starts_at,
        a.ends_at,
        a.status,
        a.winner_user_id,
        a.image_key,
        a.video_key,
        a.created_at,
        a.updated_at,
        p.name AS product_name,
        p.unit AS product_unit
       FROM auctions a
       LEFT JOIN products p ON p.id = a.product_id
       WHERE a.id = ?
       LIMIT 1`,
    )
    .bind(auctionId)
    .first<Record<string, unknown>>();
}

const HOME_PAGE_HTML = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>มหาลาภฟาร์ม V3.0</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1100px;margin:auto;padding:18px;background:#f5f7f4;color:#172018}
    .hero,.section,.auction{background:#fff;border-radius:20px;padding:20px;margin:14px 0;box-shadow:0 4px 18px #00000012}
    .hero{background:linear-gradient(135deg,#ffffff,#eef8ee)}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px}
    .tag{display:inline-block;padding:5px 10px;border-radius:999px;background:#e8f5e9;font-size:.85rem}
    .price{font-size:1.6rem;font-weight:800;margin:8px 0}
    .next{font-weight:700}
    .muted{color:#667}
    .bidbox{margin-top:16px;padding:14px;border-radius:14px;background:#f7faf7;border:1px solid #e3ebe3}
    input{width:100%;padding:12px;border:1px solid #ccd7cc;border-radius:10px;font-size:1rem;margin:8px 0}
    button{width:100%;border:0;border-radius:10px;padding:12px 14px;cursor:pointer;font-weight:700;background:#1f7a3a;color:#fff}
    button:disabled{opacity:.55;cursor:not-allowed}
    .msg{margin-top:9px;font-size:.92rem;min-height:20px}
    .history{margin-top:14px;border-top:1px solid #e5e9e5;padding-top:12px}
    .bidrow{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #edf0ed}
    .small{font-size:.86rem}
    @media(max-width:520px){body{padding:10px}.hero,.section,.auction{padding:15px}.price{font-size:1.35rem}}
  </style>
</head>
<body>
  <div class="hero">
    <span class="tag">Cloudflare Worker</span>
    <h1>มหาลาภฟาร์ม V3.0</h1>
    <p>ตลาดสินค้าและระบบประมูลไก่สำหรับลูกค้า</p>
    <p>ผู้ใช้ปัจจุบัน: <strong>ผู้ใช้ทดสอบ</strong></p>
    <p>สถานะระบบ: <strong id="status">กำลังตรวจสอบ...</strong></p>
  </div>

  <div class="section">
    <h2>รายการประมูล</h2>
    <p class="muted">ลูกค้าสามารถดูราคาและเสนอราคาได้จากหน้านี้</p>
    <div id="list">กำลังโหลด...</div>
  </div>

<script>
const DEMO_USER_ID="user-demo-001";
const money=n=>Number(n||0).toLocaleString("th-TH",{maximumFractionDigits:2});
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

async function getBids(id){
  const r=await fetch("/api/auctions/"+encodeURIComponent(id)+"/bids");
  const x=await r.json();
  if(!x.ok) throw new Error(x.error||"โหลดประวัติไม่สำเร็จ");
  return x.bids||[];
}

function renderHistory(id,bids){
  const el=document.querySelector("#history-"+CSS.escape(id));
  if(!el)return;
  if(!bids.length){el.innerHTML='<div class="muted small">ยังไม่มีผู้เสนอราคา</div>';return;}
  el.innerHTML=bids.slice(0,8).map((b,i)=>
    '<div class="bidrow small"><span>'+(i===0?'🏆 ':'')+esc(b.display_name||"ผู้ใช้")+'</span><strong>'+money(b.amount)+' บาท</strong></div>'
  ).join("");
}

async function showHistory(id){
  try{renderHistory(id,await getBids(id));}catch(e){
    const el=document.querySelector("#history-"+CSS.escape(id));
    if(el)el.innerHTML='<div class="muted small">ไม่สามารถโหลดประวัติการเสนอราคาได้</div>';
  }
}

async function submitBid(id){
  const input=document.querySelector("#bid-"+CSS.escape(id));
  const button=document.querySelector("#btn-"+CSS.escape(id));
  const msg=document.querySelector("#msg-"+CSS.escape(id));
  const amount=Number(input.value);
  if(!Number.isFinite(amount)||amount<=0){msg.textContent="กรุณาใส่จำนวนเงินที่ถูกต้อง";return;}
  button.disabled=true;msg.textContent="กำลังส่งราคา...";
  try{
    const r=await fetch("/api/auctions/"+encodeURIComponent(id)+"/bids",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-User-Id":DEMO_USER_ID},
      body:JSON.stringify({amount})
    });
    const x=await r.json();
    if(!r.ok||!x.ok){
      msg.textContent=x.minimum_bid?"เสนอราคาต่ำเกินไป — ขั้นต่ำ "+money(x.minimum_bid)+" บาท":(x.error||"เสนอราคาไม่สำเร็จ");
      return;
    }
    msg.textContent="เสนอราคา "+money(amount)+" บาท สำเร็จแล้ว ✓";
    input.value="";
    await loadAuctions();
  }catch(e){msg.textContent="เกิดข้อผิดพลาดในการเชื่อมต่อ";}
  finally{button.disabled=false;}
}

async function loadAuctions(){
  const list=document.querySelector("#list");
  try{
    const r=await fetch("/api/auctions");
    const x=await r.json();
    if(!x.ok)throw new Error(x.error||"error");
    document.querySelector("#status").textContent="พร้อมใช้งาน";
    if(!x.auctions.length){list.innerHTML='<p class="muted">ยังไม่มีรายการประมูล</p>';return;}
    list.innerHTML=x.auctions.map(a=>{
      const current=Number(a.current_price||0);
      const increment=Number(a.minimum_increment||0);
      const next=Math.max(Number(a.starting_price||0),current+increment);
      const open=String(a.status)==="OPEN";
      return '<div class="auction">'+
        '<span class="tag">'+esc(a.status)+'</span>'+ 
        '<h3>'+esc(a.title)+'</h3>'+ 
        '<p>'+esc(a.product_name||"")+'</p>'+ 
        '<div class="price">'+money(current)+' บาท</div>'+ 
        '<div class="next">เสนอขั้นต่ำครั้งถัดไป: '+money(next)+' บาท</div>'+ 
        '<p class="small muted">เริ่ม: '+esc(a.starts_at||"-")+'<br>ปิด: '+esc(a.ends_at||"-")+'</p>'+ 
        (open?'<div class="bidbox"><label for="bid-'+esc(a.id)+'"><strong>จำนวนเงินที่ต้องการเสนอ</strong></label>'+ 
          '<input id="bid-'+esc(a.id)+'" type="number" min="'+next+'" step="'+increment+'" placeholder="อย่างน้อย '+money(next)+' บาท">'+ 
          '<button id="btn-'+esc(a.id)+'" onclick="submitBid(\''+esc(a.id)+'\')">เสนอราคา</button>'+ 
          '<div class="msg" id="msg-'+esc(a.id)+'"></div></div>':'<p class="muted">รายการนี้ยังไม่เปิดให้เสนอราคา</p>')+
        '<div class="history"><strong>ประวัติราคา</strong><div id="history-'+esc(a.id)+'" class="small muted">กำลังโหลด...</div></div>'+ 
        '</div>';
    }).join("");
    for(const a of x.auctions)showHistory(String(a.id));
  }catch(e){
    document.querySelector("#status").textContent="มีปัญหา";
    list.textContent="ไม่สามารถโหลดรายการประมูลได้";
  }
}

loadAuctions();
setInterval(loadAuctions,15000);
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (method === "GET" && path === "/") {
      return new Response(HOME_PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (method === "GET" && path === "/api/health") {
      return json({
        ok: true,
        app: "mahalap-farm-v3",
        runtime: "cloudflare-workers",
        bindings: {
          d1: Boolean(env.DB),
          r2: Boolean(env.FILES),
          kv: Boolean(env.CACHE),
        },
      });
    }

    if (!env.DB) {
      return json({ ok: false, error: "D1 is not connected" }, 503);
    }

    const db = env.DB;

    // -------------------------
    // PRODUCTS
    // -------------------------

    if (method === "GET" && path === "/api/products") {
      const result = await db
        .prepare(
          `SELECT id,name,description,price,stock,unit,status
           FROM products
           WHERE status = 'ACTIVE'
           ORDER BY created_at DESC`,
        )
        .all();

      return json({ ok: true, products: result.results });
    }

    // -------------------------
    // PUBLIC AUCTION LIST
    // GET /api/auctions
    // -------------------------

    if (method === "GET" && path === "/api/auctions") {
      const status = url.searchParams.get("status");

      if (status) {
        const result = await db
          .prepare(
            `SELECT
              a.id,a.product_id,a.title,a.description,
              a.starting_price,a.current_price,a.minimum_increment,
              a.starts_at,a.ends_at,a.status,a.winner_user_id,
              a.image_key,a.video_key,a.created_at,a.updated_at,
              p.name AS product_name,p.unit AS product_unit
             FROM auctions a
             LEFT JOIN products p ON p.id = a.product_id
             WHERE a.status = ?
             ORDER BY a.ends_at ASC`,
          )
          .bind(status)
          .all();

        return json({ ok: true, auctions: result.results });
      }

      const result = await db
        .prepare(
          `SELECT
            a.id,a.product_id,a.title,a.description,
            a.starting_price,a.current_price,a.minimum_increment,
            a.starts_at,a.ends_at,a.status,a.winner_user_id,
            a.image_key,a.video_key,a.created_at,a.updated_at,
            p.name AS product_name,p.unit AS product_unit
           FROM auctions a
           LEFT JOIN products p ON p.id = a.product_id
           ORDER BY a.ends_at ASC`,
        )
        .all();

      return json({ ok: true, auctions: result.results });
    }

    // -------------------------
    // AUCTION DETAIL
    // GET /api/auctions/:id
    // -------------------------

    const detailMatch = path.match(/^\/api\/auctions\/([^/]+)$/);

    if (method === "GET" && detailMatch) {
      const auction = await getAuction(db, detailMatch[1]);

      if (!auction) {
        return json({ ok: false, error: "Auction not found" }, 404);
      }

      return json({ ok: true, auction });
    }

    // -------------------------
    // AUCTION BIDS
    // GET /api/auctions/:id/bids
    // POST /api/auctions/:id/bids
    // -------------------------

    const bidsMatch = path.match(/^\/api\/auctions\/([^/]+)\/bids$/);

    if (bidsMatch && method === "GET") {
      const result = await db
        .prepare(
          `SELECT
            b.id,b.auction_id,b.user_id,b.amount,b.created_at,
            u.display_name
           FROM auction_bids b
           LEFT JOIN users u ON u.id = b.user_id
           WHERE b.auction_id = ?
           ORDER BY b.amount DESC,b.created_at DESC`,
        )
        .bind(bidsMatch[1])
        .all();

      return json({ ok: true, bids: result.results });
    }

    if (bidsMatch && method === "POST") {
      const userId = getUserId(request);

      if (!userId) {
        return json(
          { ok: false, error: "X-User-Id is required" },
          401,
        );
      }

      const body = await readJson(request);
      const amount = Number(body.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        return json({ ok: false, error: "Invalid bid amount" }, 400);
      }

      const auction = await db
        .prepare(
          `SELECT
            id,status,starting_price,current_price,
            minimum_increment,starts_at,ends_at
           FROM auctions
           WHERE id = ?
           LIMIT 1`,
        )
        .bind(bidsMatch[1])
        .first<{
          id: string;
          status: AuctionStatus;
          starting_price: number;
          current_price: number;
          minimum_increment: number;
          starts_at: string;
          ends_at: string;
        }>();

      if (!auction) {
        return json({ ok: false, error: "Auction not found" }, 404);
      }

      const now = Date.now();
      const startsAt = new Date(auction.starts_at).getTime();
      const endsAt = new Date(auction.ends_at).getTime();

      if (
        auction.status !== "OPEN" ||
        !Number.isFinite(startsAt) ||
        !Number.isFinite(endsAt) ||
        now < startsAt ||
        now >= endsAt
      ) {
        return json({ ok: false, error: "Auction is not open" }, 400);
      }

      const minimumBid = Math.max(
        Number(auction.starting_price),
        Number(auction.current_price) +
          Number(auction.minimum_increment),
      );

      if (amount < minimumBid) {
        return json(
          {
            ok: false,
            error: "Bid amount is below minimum",
            minimum_bid: minimumBid,
          },
          400,
        );
      }

      const bidId = uuid();

      // Atomic price check prevents two requests from overwriting
      // the same current price.
      const update = await db
        .prepare(
          `UPDATE auctions
           SET current_price = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND status = 'OPEN'
             AND current_price <= ?`,
        )
        .bind(
          amount,
          bidsMatch[1],
          amount - Number(auction.minimum_increment),
        )
        .run();

      if (update.meta.changes !== 1) {
        return json(
          {
            ok: false,
            error: "Auction price changed. Please try again.",
          },
          409,
        );
      }

      await db
        .prepare(
          `INSERT INTO auction_bids
           (id,auction_id,user_id,amount)
           VALUES (?,?,?,?)`,
        )
        .bind(bidId, bidsMatch[1], userId, amount)
        .run();

      return json(
        {
          ok: true,
          bid: {
            id: bidId,
            auction_id: bidsMatch[1],
            user_id: userId,
            amount,
          },
        },
        201,
      );
    }

    // -------------------------
    // AUCTION ANNOUNCEMENTS
    // GET /api/auctions/:id/announcements
    // -------------------------

    const announcementsMatch = path.match(
      /^\/api\/auctions\/([^/]+)\/announcements$/,
    );

    if (announcementsMatch && method === "GET") {
      const result = await db
        .prepare(
          `SELECT
            aa.id,aa.auction_id,aa.admin_user_id,
            aa.message,aa.created_at,
            u.display_name AS admin_name
           FROM auction_announcements aa
           LEFT JOIN users u ON u.id = aa.admin_user_id
           WHERE aa.auction_id = ?
           ORDER BY aa.created_at DESC`,
        )
        .bind(announcementsMatch[1])
        .all();

      return json({
        ok: true,
        announcements: result.results,
      });
    }

    // -------------------------
    // ADMIN CREATE AUCTION
    // POST /api/admin/auctions
    // -------------------------

    if (method === "POST" && path === "/api/admin/auctions") {
      if (!canManageAuctions(request)) {
        return json(
          { ok: false, error: "Admin permission required" },
          403,
        );
      }

      const body = await readJson(request);

      const productId = String(body.product_id ?? "").trim();
      const title = String(body.title ?? "").trim();
      const description =
        body.description == null
          ? null
          : String(body.description);
      const startsAt = String(body.starts_at ?? "").trim();
      const endsAt = String(body.ends_at ?? "").trim();
      const startingPrice = Number(body.starting_price);
      const minimumIncrement = Number(
        body.minimum_increment ?? 1,
      );
      const imageKey =
        body.image_key == null ? null : String(body.image_key);
      const videoKey =
        body.video_key == null ? null : String(body.video_key);

      if (
        !productId ||
        !title ||
        !startsAt ||
        !endsAt ||
        !Number.isFinite(startingPrice) ||
        startingPrice < 0 ||
        !Number.isFinite(minimumIncrement) ||
        minimumIncrement <= 0
      ) {
        return json(
          { ok: false, error: "Invalid auction data" },
          400,
        );
      }

      const startTime = new Date(startsAt).getTime();
      const endTime = new Date(endsAt).getTime();

      if (
        !Number.isFinite(startTime) ||
        !Number.isFinite(endTime) ||
        endTime <= startTime
      ) {
        return json(
          { ok: false, error: "ends_at must be after starts_at" },
          400,
        );
      }

      const product = await db
        .prepare("SELECT id FROM products WHERE id = ? LIMIT 1")
        .bind(productId)
        .first<{ id: string }>();

      if (!product) {
        return json({ ok: false, error: "Product not found" }, 404);
      }

      const auctionId = uuid();

      await db
        .prepare(
          `INSERT INTO auctions
           (
             id,product_id,title,description,
             starting_price,current_price,minimum_increment,
             starts_at,ends_at,status,image_key,video_key
           )
           VALUES (?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
        )
        .bind(
          auctionId,
          productId,
          title,
          description,
          startingPrice,
          startingPrice,
          minimumIncrement,
          startsAt,
          endsAt,
          imageKey,
          videoKey,
        )
        .run();

      await logAdminAction(
        db,
        request,
        "CREATE_AUCTION",
        "auction",
        auctionId,
        { title, product_id: productId },
      );

      return json(
        {
          ok: true,
          auction_id: auctionId,
          message: "Auction created",
        },
        201,
      );
    }

    // -------------------------
    // ADMIN UPDATE AUCTION
    // PUT /api/admin/auctions/:id
    // -------------------------

    const adminAuctionMatch = path.match(
      /^\/api\/admin\/auctions\/([^/]+)$/,
    );

    if (adminAuctionMatch && method === "PUT") {
      if (!canManageAuctions(request)) {
        return json(
          { ok: false, error: "Admin permission required" },
          403,
        );
      }

      const auctionId = adminAuctionMatch[1];
      const current = await getAuction(db, auctionId);

      if (!current) {
        return json({ ok: false, error: "Auction not found" }, 404);
      }

      const body = await readJson(request);

      const allowed = [
        "title",
        "description",
        "starting_price",
        "minimum_increment",
        "starts_at",
        "ends_at",
        "status",
        "winner_user_id",
        "image_key",
        "video_key",
      ] as const;

      const fields: string[] = [];
      const values: unknown[] = [];

      for (const key of allowed) {
        if (body[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(body[key]);
        }
      }

      if (fields.length === 0) {
        return json(
          { ok: false, error: "No fields to update" },
          400,
        );
      }

      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(auctionId);

      await db
        .prepare(
          `UPDATE auctions
           SET ${fields.join(", ")}
           WHERE id = ?`,
        )
        .bind(...values)
        .run();

      await logAdminAction(
        db,
        request,
        "UPDATE_AUCTION",
        "auction",
        auctionId,
        body,
      );

      return json({ ok: true, message: "Auction updated" });
    }

    // -------------------------
    // ADMIN OPEN / CLOSE / CANCEL
    // POST /api/admin/auctions/:id/open
    // POST /api/admin/auctions/:id/close
    // POST /api/admin/auctions/:id/cancel
    // -------------------------

    const actionMatch = path.match(
      /^\/api\/admin\/auctions\/([^/]+)\/(open|close|cancel)$/,
    );

    if (actionMatch && method === "POST") {
      if (!canManageAuctions(request)) {
        return json(
          { ok: false, error: "Admin permission required" },
          403,
        );
      }

      const auctionId = actionMatch[1];
      const action = actionMatch[2];

      const auction = await db
        .prepare(
          `SELECT id,status,starts_at,ends_at
           FROM auctions
           WHERE id = ?
           LIMIT 1`,
        )
        .bind(auctionId)
        .first<{
          id: string;
          status: AuctionStatus;
          starts_at: string;
          ends_at: string;
        }>();

      if (!auction) {
        return json({ ok: false, error: "Auction not found" }, 404);
      }

      let newStatus: AuctionStatus;

      if (action === "open") {
        if (
          auction.status !== "DRAFT" &&
          auction.status !== "SCHEDULED"
        ) {
          return json(
            { ok: false, error: "Auction cannot be opened" },
            400,
          );
        }

        newStatus = "OPEN";
      } else if (action === "close") {
        if (auction.status !== "OPEN") {
          return json(
            { ok: false, error: "Only OPEN auctions can be closed" },
            400,
          );
        }

        newStatus = "CLOSED";
      } else {
        if (
          auction.status === "CLOSED" ||
          auction.status === "CANCELLED"
        ) {
          return json(
            { ok: false, error: "Auction cannot be cancelled" },
            400,
          );
        }

        newStatus = "CANCELLED";
      }

      let winnerUserId: string | null = null;

      if (newStatus === "CLOSED") {
        const highestBid = await db
          .prepare(
            `SELECT user_id,amount
             FROM auction_bids
             WHERE auction_id = ?
             ORDER BY amount DESC,created_at DESC
             LIMIT 1`,
          )
          .bind(auctionId)
          .first<{ user_id: string; amount: number }>();

        winnerUserId = highestBid?.user_id ?? null;
      }

      await db
        .prepare(
          `UPDATE auctions
           SET status = ?,
               winner_user_id = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(newStatus, winnerUserId, auctionId)
        .run();

      await logAdminAction(
        db,
        request,
        `${action.toUpperCase()}_AUCTION`,
        "auction",
        auctionId,
        { winner_user_id: winnerUserId },
      );

      return json({
        ok: true,
        status: newStatus,
        winner_user_id: winnerUserId,
      });
    }

    // -------------------------
    // ADMIN ANNOUNCEMENT
    // POST /api/admin/auctions/:id/announcements
    // -------------------------

    const adminAnnouncementMatch = path.match(
      /^\/api\/admin\/auctions\/([^/]+)\/announcements$/,
    );

    if (adminAnnouncementMatch && method === "POST") {
      if (!canAnnounce(request)) {
        return json(
          { ok: false, error: "Announcement permission required" },
          403,
        );
      }

      const adminUserId = getUserId(request);

      if (!adminUserId) {
        return json(
          { ok: false, error: "X-User-Id is required" },
          401,
        );
      }

      const auctionId = adminAnnouncementMatch[1];
      const body = await readJson(request);
      const message = String(body.message ?? "").trim();

      if (!message) {
        return json(
          { ok: false, error: "message is required" },
          400,
        );
      }

      const auction = await db
        .prepare("SELECT id FROM auctions WHERE id = ? LIMIT 1")
        .bind(auctionId)
        .first<{ id: string }>();

      if (!auction) {
        return json({ ok: false, error: "Auction not found" }, 404);
      }

      const announcementId = uuid();

      await db
        .prepare(
          `INSERT INTO auction_announcements
           (id,auction_id,admin_user_id,message)
           VALUES (?,?,?,?)`,
        )
        .bind(
          announcementId,
          auctionId,
          adminUserId,
          message,
        )
        .run();

      await logAdminAction(
        db,
        request,
        "CREATE_AUCTION_ANNOUNCEMENT",
        "auction",
        auctionId,
        { announcement_id: announcementId },
      );

      return json(
        {
          ok: true,
          announcement_id: announcementId,
        },
        201,
      );
    }

    return json({ ok: false, error: "Not Found" }, 404);
  },
} satisfies ExportedHandler<Env>;
