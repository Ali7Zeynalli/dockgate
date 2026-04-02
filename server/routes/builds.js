/**
 * Build tarixçəsi, cache və builder API route-ları
 * Niyə: Docker Desktop stilində tam build idarəetmə sistemi
 * Modul: Builds route
 * İstifadə: server/index.js
 */
const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const dockerService = require('../docker');
const { stmts } = require('../db');

// ============ BUILD HISTORY ============

// Panel-dən başladılan build tarixçəsi
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const builds = stmts.getBuilds.all(limit);
    res.json(builds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Docker-in öz build tarixçəsi — image-lərin history-si
router.get('/docker-history', async (req, res) => {
  try {
    const images = await dockerService.listImages();
    const historyList = [];

    // Gizlədilmiş image-ləri al
    const hiddenRows = stmts.getHiddenBuilds.all();
    const hiddenSet = new Set(hiddenRows.map(r => r.image_id));

    // Hər image üçün history al
    for (const img of images.slice(0, 30)) {
      try {
        // Gizlədilmiş image-ləri keç
        if (hiddenSet.has(img.id)) continue;

        const image = dockerService.docker.getImage(img.id);
        const history = await image.history();
        const tag = (img.repoTags && img.repoTags[0] !== '<none>:<none>') ? img.repoTags[0] : null;
        if (!tag) continue;

        historyList.push({
          imageId: img.id,
          tag: tag,
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
        });
      } catch(e) { /* skip */ }
    }

    res.json(historyList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Docker build history-dən image gizlət
router.post('/docker-history/hide', async (req, res) => {
  try {
    const { imageId } = req.body;
    if (!imageId) return res.status(400).json({ error: 'imageId required' });
    stmts.hideBuild.run(imageId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bütün gizlədilmiş build-ləri sıfırla
router.delete('/docker-history/hidden', async (req, res) => {
  try {
    stmts.clearHiddenBuilds.run();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tək build detalı (panel builds)
router.get('/detail/:id', async (req, res) => {
  try {
    const build = stmts.getBuild.get(req.params.id);
    if (!build) return res.status(404).json({ error: 'Build tapılmadı' });
    res.json(build);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/detail/:id', async (req, res) => {
  try {
    stmts.deleteBuild.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/', async (req, res) => {
  try {
    stmts.clearBuilds.run();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BUILD CACHE — image-ə görə qruplaşdırılmış ============

router.get('/cache', async (req, res) => {
  try {
    const df = await dockerService.getDiskUsage();
    const cacheItems = df.BuildCache || [];

    // Image-ləri al — cache-i image-lərə bağlamaq üçün
    const images = await dockerService.listImages();

    // Cache-i image-lərə görə qruplaşdır
    // Docker BuildCache-də hər item-in Description-ında image/layer məlumatı var
    // Həmçinin UsageCount və LastUsedAt var
    const groups = {};

    for (const item of cacheItems) {
      // Qrup adını təyin et
      let groupKey = 'other';
      const desc = item.Description || '';

      // Description-dan image adını çıxar
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
        // Dockerfile əmrləri — ən yaxın image-ə aid et
        // Parent chain-dən image tap
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

    // Image adlarını daha oxunaqlı et
    const result = Object.values(groups).map(g => {
      // Image-lərdən uyğun olanı tap
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

    // Ölçüyə görə sırala
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
    const result = await dockerService.pruneBuildCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ BUILDERS ============

router.get('/builders', async (req, res) => {
  try {
    exec('docker buildx ls --format "{{json .}}"', (err, stdout) => {
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
