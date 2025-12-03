// 0) Imports + dotenv (đặt TRÊN HẾT)
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.join(process.cwd(), ".env") });

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { z } from "zod";

// 1) Tạo app
const app = express();

// 2) Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// 3) Env & guard
const PORT = Number(process.env.PORT || 3000);
const GOOGLE_KEY = process.env.MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_KEY;
if (!GOOGLE_KEY) throw new Error("Missing MAPS_SERVER_KEY in .env");

// 4) Schemas
const SearchSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius: z.number().int().min(100).max(5000).default(1500),
  openNow: z.boolean().default(true),
  keyword: z.string().trim().max(60).optional(),
  // filters + paging
  minRating: z.number().min(0).max(5).default(0),
  priceLevels: z.array(z.number().int().min(0).max(4)).max(5).optional(), // [0..4]
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(20).default(10),
  // tổng số ứng viên muốn gom (sẽ đi nhiều trang Nearby nếu cần)
  max: z.number().int().min(1).max(60).optional(),
  mode: z.enum(["walking","driving"]).default("walking"),
});

const ResolveSchema = z.object({
  q: z.string().trim().min(2).max(100)
});

// --- helpers ---
function priceToNum(pl: any): number | undefined {
  if (typeof pl === "number") return pl;
  switch (pl) {
    case "PRICE_LEVEL_FREE": return 0;
    case "PRICE_LEVEL_INEXPENSIVE": return 1;
    case "PRICE_LEVEL_MODERATE": return 2;
    case "PRICE_LEVEL_EXPENSIVE": return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE": return 4;
    default: return undefined;
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Gom ứng viên từ Places Nearby qua nhiều trang
async function fetchNearbyCandidates(params: {
  key: string,
  lat: number, lng: number, radius: number,
  openNow: boolean, keyword?: string,
  rankPref: "DISTANCE" | "RELEVANCE",
  want: number // tổng số muốn lấy (vd 60)
}) {
  const FIELD_MASK = [
    "places.id",
    "places.displayName.text",
    "places.formattedAddress",
    "places.location.latitude",
    "places.location.longitude",
    "places.rating",
    "places.priceLevel",
    "places.nationalPhoneNumber",
    "places.websiteUri",
    "places.googleMapsUri",
    "places.currentOpeningHours.openNow"
  ].join(",");

  const bodyBase: any = {
    includedTypes: ["restaurant"],
    rankPreference: "DISTANCE",
    locationRestriction: { circle: { center: { latitude: params.lat, longitude: params.lng }, radius: params.radius } },
    openNow: params.openNow,
    languageCode: "en",
    regionCode: "AU",
  };

  let collected: any[] = [];
  let pageToken: string | undefined;
  let safety = 5; // tránh vòng vô hạn

  while (collected.length < params.want && safety-- > 0) {
    const take = Math.min(20, params.want - collected.length);
    const body = { ...bodyBase, maxResultCount: take, pageToken };
    const resp: any = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": params.key, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(body)
    }).then(r => r.json());

    if (!resp?.places) {
      console.log("PLACES_DEBUG:", JSON.stringify(resp).slice(0, 400));
      break;
    }
    collected = collected.concat(resp.places);
    pageToken = resp.nextPageToken;
    if (!pageToken) break;
    await sleep(1200); // nextPageToken cần delay ngắn
  }
  return collected;
}

// 5) Routes
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- /api/search ----
app.post("/api/search", async (req, res) => {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_INPUT", detail: parsed.error.flatten() });

  const {
    lat, lng, radius, openNow, keyword,
    minRating, priceLevels, page, pageSize,
    max, mode
  } = parsed.data;

  const rankPref = "DISTANCE";
  const want = Math.min(max ?? pageSize, 60);

  try {
    // 1) Lấy nhiều trang Nearby
    const places = await fetchNearbyCandidates({
      key: GOOGLE_KEY!, lat, lng, radius, openNow, keyword, rankPref, want
    });
    if (!places.length) {
      return res.json({ total: 0, page, pageSize, count: 0, results: [], origin: { lat, lng }, mode });
    }

    // 2) Distance Matrix theo lô (≤25 dest/req)
    const dests = places.map((p: any) => `${p.location.latitude},${p.location.longitude}`);
    const destChunks = chunk(dests, 25);
    const dmElems: any[] = [];
    for (const dc of destChunks) {
      const dmUrl =
        `https://maps.googleapis.com/maps/api/distancematrix/json` +
        `?origins=${lat},${lng}&destinations=${encodeURIComponent(dc.join("|"))}` +
        `&mode=${mode}&key=${GOOGLE_KEY}`;
      const dmPart: any = await fetch(dmUrl).then(r => r.json());
      const elems = dmPart?.rows?.[0]?.elements ?? [];
      dmElems.push(...elems);
    }

    // 3) Merge + sort theo duration
    const results = places.map((p: any, i: number) => {
      const e = dmElems[i];
      const travel = (e && e.status === "OK")
        ? { distanceText: e.distance?.text, durationText: e.duration?.text, seconds: e.duration?.value }
        : null;
      return {
        id: p.id,
        name: p.displayName?.text,
        address: p.formattedAddress,
        phone: p.nationalPhoneNumber,
        website: p.websiteUri,
        mapsUrl: p.googleMapsUri,
        rating: p.rating,
        priceLevel: priceToNum(p.priceLevel), // 0..4
        isOpenNow: p.currentOpeningHours?.openNow ?? null,
        lat: p.location?.latitude,
        lng: p.location?.longitude,
        travel,
      };
    }).sort((a:any,b:any)=>(a.travel?.seconds??9e9)-(b.travel?.seconds??9e9));

    // 4) Filters + Pagination
    let filtered = results.filter((r:any)=>{
  	const okRating = (r.rating ?? 0) >= minRating;
  	const okPrice = !priceLevels?.length
   	 ? true
   	 : (r.priceLevel !== undefined && priceLevels.includes(r.priceLevel));

 	 const okOpen = openNow ? (r.isOpenNow === true) : true;

  	const okKeyword = keyword
    	? (r.name && r.name.toLowerCase().includes(keyword.toLowerCase()))
    	: true;

  	return okRating && okPrice && okOpen && okKeyword;
});

    const start = (page - 1) * pageSize; // 1-based
    const paged = filtered.slice(start, start + pageSize);

    return res.json({
      total: filtered.length,
      page, pageSize,
      count: paged.length,
      results: paged,
      origin: { lat, lng }, mode
    });

  } catch (err:any) {
    console.error("SEARCH_ERROR:", err?.message || err);
    return res.status(502).json({ error: "UPSTREAM_ERROR", message: String(err?.message || err) });
  }
});

// ---- /api/resolve (Text Search v1) ----
app.post("/api/resolve", async (req, res) => {
  const p = ResolveSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_INPUT", detail: p.error.flatten() });

  const q = p.data.q;
  try {
    const resp: any = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY!,
        "X-Goog-FieldMask": "places.displayName,places.location"
      },
      body: JSON.stringify({ textQuery: q, languageCode: "en", regionCode: "AU" })
    }).then(r=>r.json());

    const first = resp?.places?.[0];
    if (!first?.location) return res.json({ ok:false, message:"NO_MATCH" });

    return res.json({
      ok: true,
      name: first.displayName?.text,
      lat: first.location.latitude,
      lng: first.location.longitude
    });
  } catch (e:any) {
    console.error("RESOLVE_ERROR:", e?.message||e);
    return res.status(502).json({ error: "UPSTREAM_ERROR" });
  }
});

// 6) Listen
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
