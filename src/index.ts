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

const homeHtml = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>มหาลาภฟาร์ม V3.0</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:1000px;margin:auto;padding:24px;background:#f5f7f4;color:#172018}
    .card{background:#fff;border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 4px 18px #00000012}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
    .tag{display:inline-block;padding:5px 10px;border-radius:999px;background:#e8f5e9}
    button{border:0;border-radius:10px;padding:9px 14px;cursor:pointer}
    .price{font-size:1.3rem;font-weight:700}
    .muted{color:#667}
  </style>
</head>
<body>
  <div class="card">
    <span class="tag">Cloudflare Worker</span>
    <h1>มหาลาภฟาร์ม V3.0</h1>
    <p>ระบบจัดการฟาร์ม สินค้า และประมูลไก่</p>
    <p>สถานะ: <strong id="status">กำลังตรวจสอบ...</strong></p>
  </div>

  <div class="card">
    <h2>ประมูลไก่</h2>
    <div id="list">กำลังโหลด...</div>
  </div>

<script>
async function loadAuctions(){
  const list=document.querySelector("#list");
  try{
    const r=await fetch("/api/auctions");
    const x=await r.json();
    if(!x.ok) throw new Error(x.error||"error");
    document.querySelector("#status").textContent="พร้อมใช้งาน";
    if(!x.auctions.length){
      list.innerHTML='<p class="muted">ยังไม่มีรายการประมูล</p>';
      return;
    }
    list.innerHTML='<div class="grid">'+x.auctions.map(a =>
      '<div class="card">'+
      '<span class="tag">'+String(a.status)+'</span>'+
      '<h3>'+String(a.title)+'</h3>'+
      '<p>'+String(a.product_name||"")+'</p>'+
      '<div class="price">'+Number(a.current_price||0).toLocaleString()+" บาท"+'</div>'+
      '<p>เริ่ม: '+String(a.starts_at||"-")+'</p>'+
      '<p>ปิด: '+String(a.ends_at||"-")+'</p>'+
      '</div>'
    ).join("")+'</div>';
  }catch(e){
    document.querySelector("#status").textContent="มีปัญหา";
    list.textContent="ไม่สามารถโหลดรายการประมูลได้";
  }
}
loadAuctions();
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
      return new Response(homeHtml, {
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
