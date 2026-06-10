/**
 * Build history, cache and builder API routes / Build tarixçəsi, cache və builder API route-ları
 * Docker Desktop style build management system / Docker Desktop stilində tam build idarəetmə sistemi
 * Module: Builds route | Used by: server/index.js
 */
const express = require('express');
const router = express.Router();
const { exec, execFile } = require('child_process');
const dockerService = require('../docker');
const { stmts } = require('../db');
const { logAction } = require('../audit');

// ============ BUILD HISTORY ============

// Build history triggered from panel / Panel-dən başladılan build tarixçəsi
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const builds = stmts.getBuilds.all(limit);
    res.json(builds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Docker's own build history — image layer history / Docker-in öz build tarixçəsi — image-lərin history-si
router.get('/docker-history', async (req, res) => {
  try {
    const images = await dockerService.listImages();
    const historyList = [];

    // Get hidden images / Gizlədilmiş image-ləri al
    const hiddenRows = stmts.getHiddenBuilds.all();
    const hiddenSet = new Set(hiddenRows.map(r => r.image_id));

    // Get history for each image — PARALLEL (was serial await before, slow with many images)
    const candidates = images.slice(0, 30).filter(img =>
      !hiddenSet.has(img.id) &&
      img.repoTags && img.repoTags[0] !== '<none>:<none>'
    );

    const results = await Promise.all(candidates.map(async (img) => {
      try {
        const image = dockerService.docker.getImage(img.id);
        const history = await image.history();
        return {
          imageId: img.id,
          tag: img.repoTags[0],
          shortId: img.shortId,
          size: img.size,
          created: img.created,
          layers: history.length,
          history: history.map(h => ({
            id: h.Id || '<missing>',
            created: h.Created,
            createdBy: h.CreatedBy || '',
            size: h.Size || 0,
            comment: h.Comment || '',
          })),
        };
      } catch(e) { return null; }
    }));

    historyList.push(...results.filter(Boolean));
    res.json(historyList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hide image from Docker build history / Docker build history-dən image gizlət
router.post('/docker-history/hide', async (req, res) => {
  try {
    const { imageId } = req.body;
    if (!imageId) return res.status(400).json({ error: 'imageId required' });
    stmts.hideBuild.run(imageId);
    logAction({ req, server: 'local', resourceType: 'build', resourceName: imageId.substring(0, 20), action: 'hide' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset all hidden builds / Bütün gizlədilmiş build-ləri sıfırla
router.delete('/docker-history/hidden', async (req, res) => {
  try {
    stmts.clearHiddenBuilds.run();
    logAction({ req, server: 'local', resourceType: 'build', resourceName: 'hidden-builds', action: 'unhide-all' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single build detail (panel builds) / Tək build detalı
router.get('/detail/:id', async (req, res) => {
  try {
    const build = stmts.getBuild.get(req.params.id);
    if (!build) return res.status(404).json({ error: 'Build not found' });
    res.json(build);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/detail/:id', async (req, res) => {
  try {
    stmts.deleteBuild.run(req.params.id);
    logAction({ req, server: 'local', resourceType: 'build', resourceName: req.params.id.substring(0, 20), action: 'delete' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/', async (req, res) => {
  try {
    stmts.clearBuilds.run();
    logAction({ req, server: 'local', resourceType: 'build', resourceName: 'all-builds', action: 'clear-history' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BUILD CACHE — grouped by image / image-ə görə qruplaşdırılmış ============

router.get('/cache', async (req, res) => {
  try {
    const df = await dockerService.getDiskUsage();
    const cacheItems = df.BuildCache || [];

    // Get images — to link cache items to images / Image-ləri al — cache-i image-lərə bağlamaq üçün
    const images = await dockerService.listImages();

    // Group cache by image — each BuildCache item has image/layer info in Description
    // Group cache by image / Cache-i image-lərə görə qruplaşdır
    const groups = {};

    for (const item of cacheItems) {
      // Determine group name / Qrup adını təyin et
      let groupKey = 'other';
      const desc = item.Description || '';

      // Extract image name from Description / Description-dan image adını çıxar
      const pullMatch = desc.match(/pulled from (.+)/i);
      const fromMatch = desc.match(/^(FROM|mount)\s+.*?\/([^\/\s:]+)/i);
      const localMatch = desc.match(/local source for (.+)/i);
      const execMatch = desc.match(/mount \/ from exec \/bin\/sh -c (.+)/i);

      if (pullMatch) {
        // "pulled from docker.io/library/node:20-alpine..." → node:20-alpine
        const fullName = pullMatch[1].split('@')[0];
        const parts = fullName.split('/');
        groupKey = parts[parts.length - 1] || fullName;
      } else if (localMatch) {
        groupKey = localMatch[1] || 'local context';
      } else if (desc.includes('WORKDIR') || desc.includes('COPY') || desc.includes('RUN') || desc.includes('ADD')) {
        // Dockerfile commands — assign to nearest image
        // Dockerfile commands — assign to nearest image
        groupKey = 'dockerfile-commands';
      } else if (item.Type === 'source.local') {
        groupKey = 'local context';
      }

      if (!groups[groupKey]) {
        groups[groupKey] = {
          name: groupKey,
          items: [],
          totalSize: 0,
          inUse: false,
          shared: false,
        };
      }
      groups[groupKey].items.push(item);
      groups[groupKey].totalSize += (item.Size || 0);
      if (item.InUse) groups[groupKey].inUse = true;
      if (item.Shared) groups[groupKey].shared = true;
    }

    // Make image names more readable / Image adlarını daha oxunaqlı et
    const result = Object.values(groups).map(g => {
      // Find matching image / Image-lərdən uyğun olanı tap
      let matchedImage = null;
      for (const img of images) {
        const tags = img.repoTags || [];
        for (const tag of tags) {
          if (tag.includes(g.name) || g.name.includes(tag.split(':')[0])) {
            matchedImage = img;
            break;
          }
        }
        if (matchedImage) break;
      }

      return {
        ...g,
        matchedImage: matchedImage ? {
          id: matchedImage.shortId,
          tag: matchedImage.repoTags[0],
          size: matchedImage.size,
        } : null,
      };
    });

    // Sort by size / Ölçüyə görə sırala
    result.sort((a, b) => b.totalSize - a.totalSize);

    res.json({
      groups: result,
      totalItems: cacheItems.length,
      totalSize: cacheItems.reduce((a, b) => a + (b.Size || 0), 0),
      raw: cacheItems,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cache/prune', async (req, res) => {
  try {
    // pruneBuildCache uses the Docker Engine API (pruneBuilder) → works on the active host (local or remote SSH)
    const result = await dockerService.pruneBuildCache();
    logAction({ req, resourceType: 'system', resourceName: 'build-cache', action: 'prune_build_cache', details: result });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ============ BUILDERS ============

router.get('/builders', async (req, res) => {
  try {
    // buildx ls is a host CLI — local daemon only. If a remote host is active, return the default builder.
    if (!dockerService.isLocalActive()) {
      return res.json([{ name: 'default', driver: 'docker', status: 'remote', isDefault: true }]);
    }
    execFile('docker', ['buildx', 'ls', '--format', '{{json .}}'], (err, stdout) => {
      if (err) {
        return res.json([{ name: 'default', driver: 'docker', status: 'running', isDefault: true }]);
      }
      try {
        const builders = stdout.trim().split('\n').filter(l => l.trim()).map(line => {
          try { return JSON.parse(line); } catch(e) { return null; }
        }).filter(Boolean);
        res.json(builders.length > 0 ? builders : [{ name: 'default', driver: 'docker', status: 'running', isDefault: true }]);
      } catch(e) {
        res.json([{ name: 'default', driver: 'docker', status: 'running', isDefault: true }]);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
