const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const GPU_BACKEND = process.env.GPU_BACKEND_URL || 'https://shipping-temp-treasurer-knit.trycloudflare.com';

// ── Health ──
app.get('/health', async (req, res) => {
  try {
    const r = await fetch(`${GPU_BACKEND}/health`, { timeout: 5000 });
    const data = await r.json();
    res.json({ status: 'ok', backend: data, proxy: 'satellite-segmentation-v1' });
  } catch (e) {
    res.json({ status: 'ok', backend: 'unreachable', proxy: 'satellite-segmentation-v1', error: e.message });
  }
});

// ── Analyze satellite image ──
app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file && !req.body.image_url && !req.body.image_base64) {
      return res.status(400).json({ error: 'Provide image as multipart file upload, image_url, or image_base64' });
    }

    let imageBuffer;
    let filename = 'satellite.jpg';

    if (req.file) {
      imageBuffer = req.file.buffer;
      filename = req.file.originalname || filename;
    } else if (req.body.image_url) {
      const imgRes = await fetch(req.body.image_url, { timeout: 30000 });
      if (!imgRes.ok) return res.status(400).json({ error: `Failed to fetch image from URL: ${imgRes.status}` });
      imageBuffer = await imgRes.buffer();
    } else if (req.body.image_base64) {
      const b64 = req.body.image_base64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(b64, 'base64');
    }

    // Forward to GPU backend
    const form = new FormData();
    form.append('image', imageBuffer, { filename, contentType: 'image/jpeg' });

    // Pass through SAM parameters
    const params = {
      points_per_side: req.body.points_per_side || 64,
      pred_iou_thresh: req.body.pred_iou_thresh || 0.82,
      stability_score_thresh: req.body.stability_score_thresh || 0.90,
      min_area_pct: req.body.min_area_pct || 0.1,
      max_area_pct: req.body.max_area_pct || 60.0,
      max_segments: req.body.max_segments || 40,
    };
    for (const [k, v] of Object.entries(params)) {
      form.append(k, String(v));
    }

    const backendRes = await fetch(`${GPU_BACKEND}/analyze/satellite/json`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 300000,
    });

    if (!backendRes.ok) {
      const errText = await backendRes.text();
      return res.status(backendRes.status).json({ error: 'GPU backend error', details: errText });
    }

    const result = await backendRes.json();

    // Return structured response
    res.json({
      annotated_image_base64: result.annotated_image,
      original_image_base64: result.original_image,
      analyses: result.analyses,
      stats: result.stats,
      annotated_image_url: `data:image/jpeg;base64,${result.annotated_image}`,
    });
  } catch (e) {
    console.error('[ANALYZE ERROR]', e.message);
    res.status(500).json({ error: 'Analysis failed', details: e.message });
  }
});

// ── Analyze with JSON body (for OnDemand agents sending base64/URL) ──
app.post('/analyze/json', async (req, res) => {
  try {
    const { image_url, image_base64, points_per_side, pred_iou_thresh, stability_score_thresh, min_area_pct, max_area_pct, max_segments } = req.body;

    if (!image_url && !image_base64) {
      return res.status(400).json({ error: 'Provide image_url or image_base64' });
    }

    let imageBuffer;
    if (image_url) {
      const imgRes = await fetch(image_url, { timeout: 30000 });
      if (!imgRes.ok) return res.status(400).json({ error: `Failed to fetch image: ${imgRes.status}` });
      imageBuffer = await imgRes.buffer();
    } else {
      const b64 = image_base64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(b64, 'base64');
    }

    const form = new FormData();
    form.append('image', imageBuffer, { filename: 'satellite.jpg', contentType: 'image/jpeg' });
    form.append('points_per_side', String(points_per_side || 64));
    form.append('pred_iou_thresh', String(pred_iou_thresh || 0.82));
    form.append('stability_score_thresh', String(stability_score_thresh || 0.90));
    form.append('min_area_pct', String(min_area_pct || 0.1));
    form.append('max_area_pct', String(max_area_pct || 60.0));
    form.append('max_segments', String(max_segments || 40));

    const backendRes = await fetch(`${GPU_BACKEND}/analyze/satellite/json`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 300000,
    });

    if (!backendRes.ok) {
      const errText = await backendRes.text();
      return res.status(backendRes.status).json({ error: 'GPU backend error', details: errText });
    }

    const result = await backendRes.json();

    // Build a direct image URL if we know the scene ID from the image_url
    let annotated_image_url = '';
    if (image_url) {
      const sceneMatch = image_url.match(/\/([A-Za-z0-9_]+)$/);
      if (sceneMatch) {
        annotated_image_url = `https://serverless.on-demand.io/apps/satellite-segmentation/analyze/image/${sceneMatch[1]}?segments=true`;
      }
    }

    res.json({
      annotated_image_base64: result.annotated_image,
      annotated_image_url,
      analyses: result.analyses,
      stats: result.stats,
    });
  } catch (e) {
    console.error('[ANALYZE-JSON ERROR]', e.message);
    res.status(500).json({ error: 'Analysis failed', details: e.message });
  }
});

// ── Serve annotated image directly (GET for agents/browsers to display) ──
app.get('/analyze/image/:sceneId', async (req, res) => {
  try {
    const { sceneId } = req.params;
    const segments = req.query.segments !== 'false';
    const itemType = req.query.item_type || 'PSScene';
    const thumbnailUrl = `https://serverless.on-demand.io/apps/planet-proxy/thumbnail/${itemType}/${sceneId}`;

    // Fetch the thumbnail
    const imgRes = await fetch(thumbnailUrl, { timeout: 30000 });
    if (!imgRes.ok) return res.status(400).json({ error: `Failed to fetch thumbnail: ${imgRes.status}` });
    const imageBuffer = await imgRes.buffer();

    if (!segments) {
      // Just return the original thumbnail
      res.set('Content-Type', 'image/jpeg');
      return res.send(imageBuffer);
    }

    // Run segmentation on the GPU backend
    const form = new FormData();
    form.append('image', imageBuffer, { filename: `${sceneId}.jpg`, contentType: 'image/jpeg' });
    form.append('points_per_side', String(req.query.points_per_side || 64));
    form.append('pred_iou_thresh', String(req.query.pred_iou_thresh || 0.82));
    form.append('stability_score_thresh', String(req.query.stability_score_thresh || 0.90));
    form.append('min_area_pct', String(req.query.min_area_pct || 0.1));
    form.append('max_area_pct', String(req.query.max_area_pct || 60.0));
    form.append('max_segments', String(req.query.max_segments || 40));

    const backendRes = await fetch(`${GPU_BACKEND}/analyze/satellite/json`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 300000,
    });

    if (!backendRes.ok) {
      const errText = await backendRes.text();
      return res.status(backendRes.status).json({ error: 'GPU backend error', details: errText });
    }

    const result = await backendRes.json();

    if (result.annotated_image) {
      const imgBuf = Buffer.from(result.annotated_image, 'base64');
      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Disposition', `inline; filename="${sceneId}_segmented.jpg"`);
      return res.send(imgBuf);
    }

    res.status(500).json({ error: 'No annotated image returned from backend' });
  } catch (e) {
    console.error('[IMAGE ERROR]', e.message);
    res.status(500).json({ error: 'Image analysis failed', details: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Satellite Segmentation proxy running on port ${PORT}`));
