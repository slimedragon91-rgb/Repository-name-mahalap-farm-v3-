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

const html = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>มหาลาภฟาร์ม V3.0</title>
  <style>
    body{
      font-family:system-ui,sans-serif;
      max-width:900px;
      margin:0 auto;
      padding:32px;
      background:#f6f7f4;
      color:#1f2937
    }
    .card{
      background:#fff;
      border-radius:18px;
      padding:24px;
      margin:16px 0;
      box-shadow:0 4px 18px #0000000d
    }
    h1{margin-top:0}
    .tag{
      display:inline-block;
      padding:6px 10px;
      border-radius:999px;
      background:#e8f5e9
    }
    code{
      background:#f1f5f9;
      padding:2px 6px;
      border-radius:6px
    }
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
      <li>ประมูลไก่</li>
      <li>บันทึกกิจกรรมและการตรวจสอบย้อนหลัง</li>
    </ul>
  </div>

<script>
fetch('/api/health')
  .then(r=>r.json())
  .then(x=>{
    document.querySelector('#status').textContent =
      x.ok ? 'พร้อมใช้งาน' : 'มีปัญหา';
  })
  .catch(()=>{
    document.querySelector('#status').textContent='เชื่อมต่อไม่ได้';
  });
</script>

</body>
</html>`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function getUserId(request: Request): string | null {
  return request.headers.get("X-User-Id");
}

/**
 * TEMPORARY TEST ONLY
 *
 * ยังไม่มี OAuth/session ใน Worker ตัวนี้
 * ดังนั้น Admin API ใช้ X-Admin-Role ชั่วคราว
 *
 * ห้ามถือเป็นระบบยืนยันตัวตนจริง
 */
function isAdmin(request: Request): boolean {
  const role = request.headers.get("X-Admin-Role");

  return (
    role === "GOD_ADMIN" ||
    role === "FARM_ADMIN" ||
    role === "CONTENT_ADMIN"
  );
}

function isStaffOrAdmin(request: Request): boolean {
  const role = request.headers.get("X-Admin-Role");

  return (
    role === "GOD_ADMIN" ||
    role === "FARM_ADMIN" ||
    role === "CONTENT_ADMIN" ||
    role === "STAFF"
  );
}

function uuid(): string {
  return crypto.randomUUID();
}

function isValidStatus(status: unknown): status is AuctionStatus {
  return [
    "DRAFT",
    "SCHEDULED",
    "OPEN",
    "CLOSED",
    "CANCELLED"
  ].includes(status as string);
}

async function logAdminAction(
  db: D1Database,
  userId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata?: unknown
): Promise<void> {
  await db.prepare(`
    INSERT INTO admin_activity_logs
      (id, user_id, action, target_type, target_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    uuid(),
    userId,
    action,
    targetType,
    targetId,
    metadata ? JSON.stringify(metadata) : null
  ).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === "GET" && path === "/") {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
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
          kv: Boolean(env.CACHE)
        }
      });
    }

    if (!env.DB) {
      return json({
        ok: false,
        error: "D1 is not connected"
      }, 503);
    }

    const db = env.DB;

    // =====================================================
    // PRODUCTS
    // =====================================================

    if (method === "GET" && path === "/api/products") {
      const result = await db.prepare(`
        SELECT
          id,
          name,
          description,
          price,
          stock,
          unit,
          status
        FROM products
        WHERE status = 'ACTIVE'
        ORDER BY created_at DESC
      `).all();

      return json({
        ok: true,
        products: result.results
      });
    }

    // =====================================================
    // AUCTIONS
    // GET /api/auctions
    // =====================================================

    if (method === "GET" && path === "/api/auctions") {
      const status = url.searchParams.get("status");

      let result;

      if (status && isValidStatus(status)) {
        result = await db.prepare(`
          SELECT
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
            p.name AS product_name,
            p.unit AS product_unit
          FROM auctions a
          LEFT JOIN products p
            ON p.id = a.product_id
          WHERE a.status = ?
          ORDER BY a.ends_at ASC
        `).bind(status).all();
      } else {
        result = await db.prepare(`
          SELECT
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
            p.name AS product_name,
            p.unit AS product_unit
          FROM auctions a
          LEFT JOIN products p
            ON p.id = a.product_id
          ORDER BY a.ends_at ASC
        `).all();
      }

      return json({
        ok: true,
        auctions: result.results
      });
    }

    // =====================================================
    // AUCTION DETAIL
    // GET /api/auctions/:id
    // =====================================================

    const auctionMatch = path.match(
      /^\\/api\\/auctions\\/([^/]+)$/
    );

    if (method === "GET" && auctionMatch) {
      const auctionId = auctionMatch[1];

      const auction = await db.prepare(`
        SELECT
          a.*,
          p.name AS product_name,
          p.unit AS product_unit
        FROM auctions a
        LEFT JOIN products p
          ON p.id = a.product_id
        WHERE a.id = ?
        LIMIT 1
      `).bind(auctionId).first();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      const images = await db.prepare(`
        SELECT
          id,
          r2_key,
          filename,
          mime_type,
          sort_order,
          created_at
        FROM auction_images
        WHERE auction_id = ?
        ORDER BY sort_order ASC, created_at ASC
      `).bind(auctionId).all();

      const videos = await db.prepare(`
        SELECT
          id,
          r2_key,
          filename,
          mime_type,
          duration_seconds,
          created_at
        FROM auction_videos
        WHERE auction_id = ?
        ORDER BY created_at ASC
      `).bind(auctionId).all();

      const participantCount = await db.prepare(`
        SELECT COUNT(*) AS count
        FROM auction_participants
        WHERE auction_id = ?
      `).bind(auctionId).first();

      return json({
        ok: true,
        auction,
        images: images.results,
        videos: videos.results,
        participant_count: participantCount?.count ?? 0
      });
    }

    // =====================================================
    // AUCTION BIDS
    // GET /api/auctions/:id/bids
    // =====================================================

    const bidsMatch = path.match(
      /^\\/api\\/auctions\\/([^/]+)\\/bids$/
    );

    if (method === "GET" && bidsMatch) {
      const auctionId = bidsMatch[1];

      const result = await db.prepare(`
        SELECT
          b.id,
          b.auction_id,
          b.user_id,
          b.amount,
          b.created_at,
          u.display_name
        FROM auction_bids b
        LEFT JOIN users u
          ON u.id = b.user_id
        WHERE b.auction_id = ?
        ORDER BY b.amount DESC, b.created_at DESC
      `).bind(auctionId).all();

      return json({
        ok: true,
        bids: result.results
      });
    }

    // =====================================================
    // AUCTION ANNOUNCEMENTS
    // GET /api/auctions/:id/announcements
    // =====================================================

    const announcementGetMatch = path.match(
      /^\\/api\\/auctions\\/([^/]+)\\/announcements$/
    );

    if (method === "GET" && announcementGetMatch) {
      const auctionId = announcementGetMatch[1];

      const result = await db.prepare(`
        SELECT
          aa.id,
          aa.auction_id,
          aa.admin_user_id,
          aa.message,
          aa.created_at,
          u.display_name AS admin_name
        FROM auction_announcements aa
        LEFT JOIN users u
          ON u.id = aa.admin_user_id
        WHERE aa.auction_id = ?
        ORDER BY aa.created_at DESC
      `).bind(auctionId).all();

      return json({
        ok: true,
        announcements: result.results
      });
    }

    // =====================================================
    // JOIN AUCTION
    // POST /api/auctions/:id/join
    // =====================================================

    const joinMatch = path.match(
      /^\\/api\\/auctions\\/([^/]+)\\/join$/
    );

    if (method === "POST" && joinMatch) {
      const auctionId = joinMatch[1];
      const userId = getUserId(request);

      if (!userId) {
        return json({
          ok: false,
          error: "X-User-Id is required in test mode"
        }, 401);
      }

      const auction = await db.prepare(`
        SELECT id, status, starts_at, ends_at
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first<{
        id: string;
        status: AuctionStatus;
        starts_at: string;
        ends_at: string;
      }>();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      const now = new Date().toISOString();

      if (
        auction.status !== "OPEN" ||
        now >= auction.ends_at
      ) {
        return json({
          ok: false,
          error: "Auction is not open"
        }, 400);
      }

      await db.prepare(`
        INSERT OR IGNORE INTO auction_participants
          (id, auction_id, user_id)
        VALUES (?, ?, ?)
      `).bind(
        uuid(),
        auctionId,
        userId
      ).run();

      return json({
        ok: true,
        auction_id: auctionId,
        user_id: userId,
        joined: true
      });
    }

    // =====================================================
    // PLACE BID
    // POST /api/auctions/:id/bids
    // =====================================================

    if (method === "POST" && bidsMatch) {
      const auctionId = bidsMatch[1];
      const userId = getUserId(request);

      if (!userId) {
        return json({
          ok: false,
          error: "X-User-Id is required in test mode"
        }, 401);
      }

      let body: {
        amount?: unknown;
      };

      try {
        body = await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON body"
        }, 400);
      }

      const amount = Number(body.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        return json({
          ok: false,
          error: "Invalid bid amount"
        }, 400);
      }

      const auction = await db.prepare(`
        SELECT
          id,
          status,
          current_price,
          starting_price,
          minimum_increment,
          starts_at,
          ends_at
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first<{
        id: string;
        status: AuctionStatus;
        current_price: number;
        starting_price: number;
        minimum_increment: number;
        starts_at: string;
        ends_at: string;
      }>();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      const now = new Date();

      if (auction.status !== "OPEN") {
        return json({
          ok: false,
          error: "Auction is not open"
        }, 400);
      }

      if (now < new Date(auction.starts_at)) {
        return json({
          ok: false,
          error: "Auction has not started"
        }, 400);
      }

      if (now >= new Date(auction.ends_at)) {
        return json({
          ok: false,
          error: "Auction has ended"
        }, 400);
      }

      const minimumBid =
        Number(auction.current_price) +
        Number(auction.minimum_increment);

      if (amount < minimumBid) {
        return json({
          ok: false,
          error: "Bid is below minimum",
          current_price: auction.current_price,
          minimum_increment: auction.minimum_increment,
          minimum_bid: minimumBid
        }, 400);
      }

      /*
       * Update price only when the requested bid is
       * higher than the current price.
       */
      const update = await db.prepare(`
        UPDATE auctions
        SET
          current_price = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'OPEN'
          AND ends_at > CURRENT_TIMESTAMP
          AND current_price < ?
      `).bind(
        amount,
        auctionId,
        amount
      ).run();

      if (!update.meta.changes) {
        return json({
          ok: false,
          error: "Bid was beaten by another bid. Please try again."
        }, 409);
      }

      try {
        await db.prepare(`
          INSERT INTO auction_bids
            (id, auction_id, user_id, amount)
          VALUES (?, ?, ?, ?)
        `).bind(
          uuid(),
          auctionId,
          userId,
          amount
        ).run();
      } catch (error) {
        /*
         * If inserting the bid fails, restore the old price.
         */
        await db.prepare(`
          UPDATE auctions
          SET
            current_price = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          auction.current_price,
          auctionId
        ).run();

        throw error;
      }

      await db.prepare(`
        INSERT OR IGNORE INTO auction_participants
          (id, auction_id, user_id)
        VALUES (?, ?, ?)
      `).bind(
        uuid(),
        auctionId,
        userId
      ).run();

      return json({
        ok: true,
        message: "Bid accepted",
        auction_id: auctionId,
        amount
      }, 201);
    }

    // =====================================================
    // ADMIN CREATE AUCTION
    // POST /api/admin/auctions
    // =====================================================

    if (
      method === "POST" &&
      path === "/api/admin/auctions"
    ) {
      if (!isAdmin(request)) {
        return json({
          ok: false,
          error: "Admin permission required"
        }, 403);
      }

      let body: {
        product_id?: unknown;
        title?: unknown;
        description?: unknown;
        starting_price?: unknown;
        minimum_increment?: unknown;
        starts_at?: unknown;
        ends_at?: unknown;
        status?: unknown;
        image_key?: unknown;
        video_key?: unknown;
      };

      try {
        body = await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON body"
        }, 400);
      }

      const productId = String(body.product_id ?? "").trim();
      const title = String(body.title ?? "").trim();
      const description =
        body.description == null
          ? null
          : String(body.description);

      const startingPrice = Number(body.starting_price);
      const minimumIncrement = Number(body.minimum_increment);

      const startsAt = String(body.starts_at ?? "").trim();
      const endsAt = String(body.ends_at ?? "").trim();

      const imageKey =
        body.image_key == null
          ? null
          : String(body.image_key);

      const videoKey =
        body.video_key == null
          ? null
          : String(body.video_key);

      let status: AuctionStatus =
        (body.status as AuctionStatus) || "DRAFT";

      if (!isValidStatus(status)) {
        status = "DRAFT";
      }

      if (!productId || !title) {
        return json({
          ok: false,
          error: "product_id and title are required"
        }, 400);
      }

      if (
        !Number.isFinite(startingPrice) ||
        startingPrice < 0
      ) {
        return json({
          ok: false,
          error: "Invalid starting_price"
        }, 400);
      }

      if (
        !Number.isFinite(minimumIncrement) ||
        minimumIncrement <= 0
      ) {
        return json({
          ok: false,
          error: "Invalid minimum_increment"
        }, 400);
      }

      const startDate = new Date(startsAt);
      const endDate = new Date(endsAt);

      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime()) ||
        endDate <= startDate
      ) {
        return json({
          ok: false,
          error: "Invalid auction dates"
        }, 400);
      }

      const product = await db.prepare(`
        SELECT id, name
        FROM products
        WHERE id = ?
        LIMIT 1
      `).bind(productId).first();

      if (!product) {
        return json({
          ok: false,
          error: "Product not found"
        }, 404);
      }

      const auctionId = uuid();

      await db.prepare(`
        INSERT INTO auctions (
          id,
          product_id,
          title,
          description,
          starting_price,
          current_price,
          minimum_increment,
          starts_at,
          ends_at,
          status,
          image_key,
          video_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        auctionId,
        productId,
        title,
        description,
        startingPrice,
        startingPrice,
        minimumIncrement,
        startDate.toISOString(),
        endDate.toISOString(),
        status,
        imageKey,
        videoKey
      ).run();

      await db.prepare(`
        INSERT INTO auction_settings (
          auction_id
        )
        VALUES (?)
      `).bind(auctionId).run();

      const adminUserId = getUserId(request);

      await db.prepare(`
        INSERT INTO auction_status_history (
          id,
          auction_id,
          old_status,
          new_status,
          changed_by,
          reason
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        uuid(),
        auctionId,
        null,
        status,
        adminUserId,
        "Auction created"
      ).run();

      await logAdminAction(
        db,
        adminUserId,
        "CREATE_AUCTION",
        "auction",
        auctionId,
        {
          title,
          product_id: productId
        }
      );

      return json({
        ok: true,
        message: "Auction created",
        auction_id: auctionId
      }, 201);
    }

    // =====================================================
    // ADMIN UPDATE AUCTION
    // PUT /api/admin/auctions/:id
    // =====================================================

    const adminAuctionMatch = path.match(
      /^\\/api\\/admin\\/auctions\\/([^/]+)$/
    );

    if (
      method === "PUT" &&
      adminAuctionMatch
    ) {
      if (!isAdmin(request)) {
        return json({
          ok: false,
          error: "Admin permission required"
        }, 403);
      }

      const auctionId = adminAuctionMatch[1];

      let body: {
        title?: unknown;
        description?: unknown;
        starting_price?: unknown;
        minimum_increment?: unknown;
        starts_at?: unknown;
        ends_at?: unknown;
        image_key?: unknown;
        video_key?: unknown;
      };

      try {
        body = await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON body"
        }, 400);
      }

      const current = await db.prepare(`
        SELECT *
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first<{
        status: AuctionStatus;
      }>();

      if (!current) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      const title = String(
        body.title ?? ""
      ).trim();

      if (!title) {
        return json({
          ok: false,
          error: "title is required"
        }, 400);
      }

      const description =
        body.description == null
          ? null
          : String(body.description);

      const startingPrice = Number(
        body.starting_price
      );

      const minimumIncrement = Number(
        body.minimum_increment
      );

      const startsAt = String(
        body.starts_at ?? ""
      );

      const endsAt = String(
        body.ends_at ?? ""
      );

      if (
        !Number.isFinite(startingPrice) ||
        startingPrice < 0
      ) {
        return json({
          ok: false,
          error: "Invalid starting_price"
        }, 400);
      }

      if (
        !Number.isFinite(minimumIncrement) ||
        minimumIncrement <= 0
      ) {
        return json({
          ok: false,
          error: "Invalid minimum_increment"
        }, 400);
      }

      const startDate = new Date(startsAt);
      const endDate = new Date(endsAt);

      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime()) ||
        endDate <= startDate
      ) {
        return json({
          ok: false,
          error: "Invalid auction dates"
        }, 400);
      }

      await db.prepare(`
        UPDATE auctions
        SET
          title = ?,
          description = ?,
          starting_price = ?,
          minimum_increment = ?,
          starts_at = ?,
          ends_at = ?,
          image_key = ?,
          video_key = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        title,
        description,
        startingPrice,
        minimumIncrement,
        startDate.toISOString(),
        endDate.toISOString(),
        body.image_key == null ? null : String(body.image_key),
        body.video_key == null ? null : String(body.video_key),
        auctionId
      ).run();

      await logAdminAction(
        db,
        getUserId(request),
        "UPDATE_AUCTION",
        "auction",
        auctionId
      );

      return json({
        ok: true,
        message: "Auction updated",
        auction_id: auctionId
      });
    }

    // =====================================================
    // ADMIN OPEN AUCTION
    // POST /api/admin/auctions/:id/open
    // =====================================================

    const openMatch = path.match(
      /^\\/api\\/admin\\/auctions\\/([^/]+)\\/open$/
    );

    if (method === "POST" && openMatch) {
      if (!isAdmin(request)) {
        return json({
          ok: false,
          error: "Admin permission required"
        }, 403);
      }

      const auctionId = openMatch[1];

      const auction = await db.prepare(`
        SELECT *
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first<{
        id: string;
        status: AuctionStatus;
        starts_at: string;
        ends_at: string;
      }>();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      const now = new Date();

      if (now >= new Date(auction.ends_at)) {
        return json({
          ok: false,
          error: "Auction end time has passed"
        }, 400);
      }

      if (
        auction.status === "CLOSED" ||
        auction.status === "CANCELLED"
      ) {
        return json({
          ok: false,
          error: "Auction cannot be opened"
        }, 400);
      }

      await db.prepare(`
        UPDATE auctions
        SET
          status = 'OPEN',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(auctionId).run();

      await db.prepare(`
        INSERT INTO auction_status_history (
          id,
          auction_id,
          old_status,
          new_status,
          changed_by,
          reason
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        uuid(),
        auctionId,
        auction.status,
        "OPEN",
        getUserId(request),
        "Opened by admin"
      ).run();

      await logAdminAction(
        db,
        getUserId(request),
        "OPEN_AUCTION",
        "auction",
        auctionId
      );

      return json({
        ok: true,
        message: "Auction opened"
      });
    }

    // =====================================================
    // ADMIN CLOSE AUCTION
    // POST /api/admin/auctions/:id/close
    // =====================================================

    const closeMatch = path.match(
      /^\\/api\\/admin\\/auctions\\/([^/]+)\\/close$/
    );

    if (method === "POST" && closeMatch) {
      if (!isAdmin(request)) {
        return json({
          ok: false,
          error: "Admin permission required"
        }, 403);
      }

      const auctionId = closeMatch[1];

      const auction = await db.prepare(`
        SELECT *
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first<{
        id: string;
        status: AuctionStatus;
        current_price: number;
      }>();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      if (
        auction.status === "CLOSED" ||
        auction.status === "CANCELLED"
      ) {
        return json({
          ok: false,
          error: "Auction is already closed"
        }, 400);
      }

      const highestBid = await db.prepare(`
        SELECT
          id,
          user_id,
          amount
        FROM auction_bids
        WHERE auction_id = ?
        ORDER BY amount DESC, created_at ASC
        LIMIT 1
      `).bind(auctionId).first<{
        id: string;
        user_id: string;
        amount: number;
      }>();

      await db.prepare(`
        UPDATE auctions
        SET
          status = 'CLOSED',
          winner_user_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        highestBid?.user_id ?? null,
        auctionId
      ).run();

      if (highestBid) {
        await db.prepare(`
          INSERT OR REPLACE INTO auction_winners (
            id,
            auction_id,
            user_id,
            winning_bid_id,
            winning_amount
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          uuid(),
          auctionId,
          highestBid.user_id,
          highestBid.id,
          highestBid.amount
        ).run();
      }

      await db.prepare(`
        INSERT INTO auction_status_history (
          id,
          auction_id,
          old_status,
          new_status,
          changed_by,
          reason
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        uuid(),
        auctionId,
        auction.status,
        "CLOSED",
        getUserId(request),
        highestBid
          ? "Auction closed with winner"
          : "Auction closed without bids"
      ).run();

      await logAdminAction(
        db,
        getUserId(request),
        "CLOSE_AUCTION",
        "auction",
        auctionId,
        {
          winner_user_id: highestBid?.user_id ?? null,
          winning_amount: highestBid?.amount ?? null
        }
      );

      return json({
        ok: true,
        message: "Auction closed",
        winner: highestBid
          ? {
              user_id: highestBid.user_id,
              amount: highestBid.amount
            }
          : null
      });
    }

    // =====================================================
    // ADMIN CANCEL AUCTION
    // POST /api/admin/auctions/:id/cancel
    // =====================================================

    const cancelMatch = path.match(
      /^\\/api\\/admin\\/auctions\\/([^/]+)\\/cancel$/
    );

    if (method === "POST" && cancelMatch) {
      if (!isAdmin(request)) {
        return json({
          ok: false,
          error: "Admin permission required"
        }, 403);
      }

      const auctionId = cancelMatch[1];

      const auction = await db.prepare(`
        SELECT id, status
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first<{
        id: string;
        status: AuctionStatus;
      }>();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      if (
        auction.status === "CLOSED" ||
        auction.status === "CANCELLED"
      ) {
        return json({
          ok: false,
          error: "Auction cannot be cancelled"
        }, 400);
      }

      await db.prepare(`
        UPDATE auctions
        SET
          status = 'CANCELLED',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(auctionId).run();

      await db.prepare(`
        INSERT INTO auction_status_history (
          id,
          auction_id,
          old_status,
          new_status,
          changed_by,
          reason
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        uuid(),
        auctionId,
        auction.status,
        "CANCELLED",
        getUserId(request),
        "Cancelled by admin"
      ).run();

      await logAdminAction(
        db,
        getUserId(request),
        "CANCEL_AUCTION",
        "auction",
        auctionId
      );

      return json({
        ok: true,
        message: "Auction cancelled"
      });
    }

    // =====================================================
    // ADMIN ANNOUNCEMENT
    // POST /api/admin/auctions/:id/announcements
    // =====================================================

    const announcementPostMatch = path.match(
      /^\\/api\\/admin\\/auctions\\/([^/]+)\\/announcements$/
    );

    if (
      method === "POST" &&
      announcementPostMatch
    ) {
      if (!isAdmin(request)) {
        return json({
          ok: false,
          error: "Admin permission required"
        }, 403);
      }

      const auctionId = announcementPostMatch[1];
      const adminUserId = getUserId(request);

      if (!adminUserId) {
        return json({
          ok: false,
          error: "X-User-Id is required in test mode"
        }, 401);
      }

      const auction = await db.prepare(`
        SELECT id
        FROM auctions
        WHERE id = ?
        LIMIT 1
      `).bind(auctionId).first();

      if (!auction) {
        return json({
          ok: false,
          error: "Auction not found"
        }, 404);
      }

      let body: {
        message?: unknown;
      };

      try {
        body = await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid JSON body"
        }, 400);
      }

      const message = String(
        body.message ?? ""
      ).trim();

      if (!message) {
        return json({
          ok: false,
          error: "message is required"
        }, 400);
      }

      if (message.length > 1000) {
        return json({
          ok: false,
          error: "message is too long"
        }, 400);
      }

      const announcementId = uuid();

      await db.prepare(`
        INSERT INTO auction_announcements (
          id,
          auction_id,
          admin_user_id,
          message
        )
        VALUES (?, ?, ?, ?)
      `).bind(
        announcementId,
        auctionId,
        adminUserId,
        message
      ).run();

      await logAdminAction(
        db,
        adminUserId,
        "CREATE_AUCTION_ANNOUNCEMENT",
        "auction",
        auctionId,
        {
          announcement_id: announcementId
        }
      );

      return json({
        ok: true,
        announcement_id: announcementId
      }, 201);
    }

    return json({
      ok: false,
      error: "Not Found"
    }, 404);
  }
} satisfies ExportedHandler<Env>;
