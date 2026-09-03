# มหาลาภฟาร์ม V3.0

Cloudflare-native foundation สำหรับระบบจัดการฟาร์มและสินค้า

## โครงสร้าง
- Cloudflare Workers: API + Web
- Cloudflare D1: Database (ผูกภายหลัง)
- Cloudflare R2: ไฟล์/สลิป (ผูกภายหลัง)
- Cloudflare KV: Cache/temporary data (ผูกภายหลัง)

## Deploy ขั้นแรก
```bash
npm install
npx wrangler deploy
```

## หลัง Worker Deploy สำเร็จ
ค่อยสร้างทรัพยากร:
```bash
npx wrangler d1 create mahalap-farm-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create mahalap-farm-files
```

จากนั้นเพิ่ม bindings/IDs จริงใน `wrangler.jsonc` และรัน migration

> ห้ามใส่ secret จริงลง GitHub และการอัปโหลดสลิปไม่ได้หมายความว่าระบบตรวจสอบเงินจากธนาคารอัตโนมัติ
