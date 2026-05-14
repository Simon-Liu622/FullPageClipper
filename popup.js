// ==========================================
// 弹窗 UI 交互逻辑
// ==========================================
const messages = {
  en: {
    pdfBtn: 'Export paged PDF',
    imageBtn: 'Export full long image',
    pauseBtn: 'Stop and save',
    ready: 'Ready',
    preparing: 'Preparing rendered capture...',
    noActiveTab: 'No active tab found',
    planned: 'Ready to capture {total} viewport images...',
    capturing: 'Capturing {current}/{total}',
    savingCurrent: 'Saving after the current section...',
    partialPdfDone: 'Captured portion saved as PDF',
    partialImageDone: 'Captured portion saved as long image',
    bindingPdf: 'Assembling PDF...',
    stitchingImage: 'Stitching full long image...',
    pdfDone: 'PDF generated and download started',
    imageDone: 'Long image generated and download started',
    errorPrefix: 'Error: ',
    noPages: 'No screenshot pages were generated',
    imageEncodeFailed: 'Long image encoding failed',
    downloadMissing: 'Browser did not return a download task',
    screenshotReadFailed: 'Failed to read screenshot image',
    pdfFilePrefix: 'Screenshot_Document',
    imageFilePrefix: 'Full_Long_Image',
    fallbackTitle: 'webpage'
  },
  zh_CN: {
    pdfBtn: '导出分页 PDF',
    imageBtn: '导出完整长图',
    pauseBtn: '停止并保存',
    ready: '准备就绪',
    preparing: '正在准备真实渲染截图...',
    noActiveTab: '没有找到当前标签页',
    planned: '准备截取 {total} 张视口图...',
    capturing: '正在截图 {current}/{total}',
    savingCurrent: '当前段截完后立即保存...',
    partialPdfDone: '已保存当前截取部分为 PDF',
    partialImageDone: '已保存当前截取部分为长图',
    bindingPdf: '正在装订 PDF...',
    stitchingImage: '正在拼接完整长图...',
    pdfDone: 'PDF 已生成并开始下载',
    imageDone: '长图已生成并开始下载',
    errorPrefix: '发生错误: ',
    noPages: '没有生成任何截图页面',
    imageEncodeFailed: '长图编码失败',
    downloadMissing: '浏览器没有返回下载任务',
    screenshotReadFailed: '截图图片读取失败',
    pdfFilePrefix: '智能排版文档',
    imageFilePrefix: '完整长图',
    fallbackTitle: '网页截图'
  }
};

const captureControl = {
  isRunning: false,
  stopRequested: false
};

let currentLanguage = localStorage.getItem('fullPageClipperLanguage') || 'en';
if (!messages[currentLanguage]) {
  currentLanguage = 'en';
}

initializePopup();
bindExportButton('pdfBtn', 'pdf');
bindExportButton('imageBtn', 'image');
document.getElementById('pauseBtn').addEventListener('click', togglePause);

function initializePopup() {
  const languageSelect = document.getElementById('languageSelect');
  languageSelect.value = currentLanguage;
  languageSelect.addEventListener('change', () => {
    currentLanguage = languageSelect.value;
    localStorage.setItem('fullPageClipperLanguage', currentLanguage);
    renderPopupText();
  });
  renderPopupText();
}

function renderPopupText() {
  document.documentElement.lang = currentLanguage === 'zh_CN' ? 'zh-CN' : 'en';
  document.getElementById('pdfBtn').textContent = t('pdfBtn');
  document.getElementById('imageBtn').textContent = t('imageBtn');
  updatePauseButton();

  const statusInfo = document.getElementById('status');
  if (!captureControl.isRunning) {
    statusInfo.textContent = t('ready');
  } else if (captureControl.stopRequested) {
    statusInfo.textContent = t('savingCurrent');
  }
}

function t(key, values = {}) {
  let text = (messages[currentLanguage] && messages[currentLanguage][key]) || messages.en[key] || key;
  Object.keys(values).forEach((name) => {
    text = text.replace(`{${name}}`, values[name]);
  });
  return text;
}

function bindExportButton(buttonId, format) {
  document.getElementById(buttonId).addEventListener('click', () => {
    runCapture(format);
  });
}

function togglePause() {
  if (!captureControl.isRunning) return;
  captureControl.stopRequested = true;
  updatePauseButton();
  document.getElementById('status').textContent = t('savingCurrent');
}

function updatePauseButton() {
  const pauseBtn = document.getElementById('pauseBtn');
  pauseBtn.textContent = t('pauseBtn');
  pauseBtn.disabled = captureControl.stopRequested;
  pauseBtn.style.display = captureControl.isRunning ? 'block' : 'none';
}

async function runCapture(format) {
  const exportButtons = [document.getElementById('pdfBtn'), document.getElementById('imageBtn')];
  const statusInfo = document.getElementById('status');

  captureControl.isRunning = true;
  captureControl.stopRequested = false;
  exportButtons.forEach((button) => {
    button.disabled = true;
  });
  updatePauseButton();
  statusInfo.textContent = t('preparing');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error(t('noActiveTab'));
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: installRenderedCaptureHelper
    });

    const [{ result: plan }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__fullPageClipper.prepare()
    });

    statusInfo.textContent = t('planned', { total: plan.totalTiles });
    if (format === 'image') {
      await captureRenderedLongImage(tab.id, plan, statusInfo);
      statusInfo.textContent = captureControl.stopRequested ? t('partialImageDone') : t('imageDone');
    } else {
      await captureRenderedPdf(tab.id, plan, statusInfo);
      statusInfo.textContent = captureControl.stopRequested ? t('partialPdfDone') : t('pdfDone');
    }
  } catch (err) {
    statusInfo.textContent = t('errorPrefix') + err.message;
  } finally {
    captureControl.isRunning = false;
    captureControl.stopRequested = false;
    exportButtons.forEach((button) => {
      button.disabled = false;
    });
    updatePauseButton();
  }
}

async function captureRenderedPdf(tabId, plan, statusInfo) {
  const segments = await captureRenderedSegments(tabId, plan, statusInfo);
  const pages = mergeSegmentsForPdf(segments);
  if (pages.length === 0) {
    throw new Error(t('noPages'));
  }

  statusInfo.textContent = t('bindingPdf');
  const pdfBlob = await createImagePdfBlob(pages);
  const safeTitle = sanitizeFileName(plan.title || t('fallbackTitle')).substring(0, 30);
  await downloadBlob(pdfBlob, `${t('pdfFilePrefix')}_${safeTitle}.pdf`);
}

async function captureRenderedLongImage(tabId, plan, statusInfo) {
  const segments = await captureRenderedSegments(tabId, plan, statusInfo);
  if (segments.length === 0) {
    throw new Error(t('noPages'));
  }

  statusInfo.textContent = t('stitchingImage');
  const longCanvas = stitchSegmentsToLongCanvas(segments);
  const blob = await canvasToBlob(longCanvas, 'image/jpeg', 0.95);
  const safeTitle = sanitizeFileName(plan.title || t('fallbackTitle')).substring(0, 30);
  await downloadBlob(blob, `${t('imageFilePrefix')}_${safeTitle}.jpg`);
}

async function captureRenderedSegments(tabId, plan, statusInfo) {
  const segments = [];
  let tileIndex = 0;

  try {
    for (let rowIndex = 0; rowIndex < plan.yPositions.length; rowIndex++) {
      const y = plan.yPositions[rowIndex];
      const rowCanvas = document.createElement('canvas');
      const rowCtx = rowCanvas.getContext('2d');
      let rowScale = 1;
      let rowReady = false;

      for (let colIndex = 0; colIndex < plan.xPositions.length; colIndex++) {
        const x = plan.xPositions[colIndex];
        const hideRepeating = tileIndex > 0;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (args) => window.__fullPageClipper.scrollToTile(args),
          args: [{ x, y, hideRepeating }]
        });

        const dataUrl = await captureVisibleTabImage();
        const img = await loadImage(dataUrl);

        if (!rowReady) {
          rowScale = img.naturalWidth / plan.viewportWidth;
          rowCanvas.width = Math.max(1, Math.ceil(plan.captureWidth * rowScale));
          rowCanvas.height = Math.max(1, Math.ceil(plan.viewportHeight * rowScale));
          rowCtx.fillStyle = '#ffffff';
          rowCtx.fillRect(0, 0, rowCanvas.width, rowCanvas.height);
          rowReady = true;
        }

        const destX = Math.round(x * rowScale);
        rowCtx.drawImage(img, destX, 0);

        tileIndex++;
        statusInfo.textContent = t('capturing', { current: tileIndex, total: plan.totalTiles });
      }

      segments.push(createContentSegment(rowCanvas, plan, rowIndex, rowScale));
      if (captureControl.stopRequested) {
        break;
      }
    }
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__fullPageClipper.restore()
    }).catch(() => {});
  }

  return segments;
}

function createContentSegment(rowCanvas, plan, rowIndex, scale) {
  const nextY = plan.yPositions[rowIndex + 1];
  let sourceTop = 0;
  let segmentCssHeight = nextY == null ? plan.viewportHeight : nextY - plan.yPositions[rowIndex];
  let segmentCanvas = null;

  if (plan.internalScrollMask && rowIndex > 0) {
    sourceTop = plan.internalScrollMask.top;
    segmentCssHeight = nextY == null ? plan.internalScrollMask.height : nextY - plan.yPositions[rowIndex];
  }

  const sourceY = clamp(Math.round(sourceTop * scale), 0, rowCanvas.height);
  const sourceHeight = clamp(
    Math.round(segmentCssHeight * scale),
    1,
    rowCanvas.height - sourceY
  );

  if (sourceY === 0 && sourceHeight === rowCanvas.height) {
    segmentCanvas = rowCanvas;
  } else {
    segmentCanvas = document.createElement('canvas');
    segmentCanvas.width = rowCanvas.width;
    segmentCanvas.height = sourceHeight;
    const segmentCtx = segmentCanvas.getContext('2d');
    segmentCtx.fillStyle = '#ffffff';
    segmentCtx.fillRect(0, 0, segmentCanvas.width, segmentCanvas.height);
    segmentCtx.drawImage(
      rowCanvas,
      0,
      sourceY,
      rowCanvas.width,
      sourceHeight,
      0,
      0,
      rowCanvas.width,
      sourceHeight
    );
  }

  if (plan.internalScrollMask && rowIndex > 0) {
    blankInternalScrollSides(segmentCanvas, plan.internalScrollMask, scale);
  }

  return segmentCanvas;
}

function blankInternalScrollSides(canvas, rect, scale) {
  const ctx = canvas.getContext('2d');
  const left = clamp(Math.round(rect.left * scale), 0, canvas.width);
  const right = clamp(Math.round(rect.right * scale), 0, canvas.width);
  ctx.fillStyle = '#ffffff';

  if (left > 0) {
    ctx.fillRect(0, 0, left, canvas.height);
  }
  if (right < canvas.width) {
    ctx.fillRect(right, 0, canvas.width - right, canvas.height);
  }
}

function mergeSegmentsForPdf(segments) {
  if (segments.length === 0) return [];

  const pageHeightLimit = segments[0].height;
  const pages = [];
  let pending = [];
  let pendingHeight = 0;

  const flush = () => {
    if (pending.length === 0) return;
    pages.push(stitchSegmentsToCanvas(pending));
    pending = [];
    pendingHeight = 0;
  };

  segments.forEach((segment) => {
    const canAppend = pending.length === 0 || pendingHeight + segment.height <= pageHeightLimit * 1.6;
    if (!canAppend) {
      flush();
    }
    pending.push(segment);
    pendingHeight += segment.height;
  });
  flush();

  return pages;
}

function stitchSegmentsToLongCanvas(segments) {
  return stitchSegmentsToCanvas(segments, true);
}

function stitchSegmentsToCanvas(segments, allowDownscale = false) {
  const sourceWidth = segments[0].width;
  const sourceHeight = segments.reduce((sum, segment) => sum + segment.height, 0);
  const maxHeight = 30000;
  const maxArea = 160000000;
  const areaScale = Math.sqrt(maxArea / Math.max(1, sourceWidth * sourceHeight));
  const outputScale = allowDownscale ? Math.min(1, maxHeight / sourceHeight, areaScale) : 1;
  const width = Math.max(1, Math.floor(sourceWidth * outputScale));
  const height = Math.max(1, Math.floor(sourceHeight * outputScale));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let y = 0;
  segments.forEach((segment) => {
    const segmentHeight = Math.max(1, Math.round(segment.height * outputScale));
    ctx.drawImage(segment, 0, y, width, segmentHeight);
    y += segmentHeight;
  });

  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error(t('imageEncodeFailed')));
    }, type, quality);
  });
}

async function createImagePdfBlob(canvases) {
  const objects = [];
  const offsets = [0];
  let byteLength = 0;

  const append = (part) => {
    objects.push(part);
    byteLength += typeof part === 'string' ? part.length : part.byteLength;
  };

  const addObject = (id, parts) => {
    offsets[id] = byteLength;
    append(`${id} 0 obj\n`);
    parts.forEach(append);
    append('\nendobj\n');
  };

  const pageIds = canvases.map((_, index) => 3 + index * 3);
  const maxObjectId = 2 + canvases.length * 3;

  append('%PDF-1.3\n');
  append('%\xFF\xFF\xFF\xFF\n');
  addObject(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  addObject(2, [`<< /Type /Pages /Count ${canvases.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`]);

  for (let index = 0; index < canvases.length; index++) {
    const canvas = canvases[index];
    const pageId = pageIds[index];
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const imageName = `Im${index + 1}`;
    const jpegBytes = await canvasToJpegBytes(canvas, 0.95);
    const content = `q\n${canvas.width} 0 0 ${canvas.height} 0 0 cm\n/${imageName} Do\nQ\n`;

    addObject(pageId, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${canvas.width} ${canvas.height}] `,
      `/Resources << /XObject << /${imageName} ${imageId} 0 R >> >> `,
      `/Contents ${contentId} 0 R >>`
    ]);
    addObject(imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} `,
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`,
      jpegBytes,
      '\nendstream'
    ]);
    addObject(contentId, [
      `<< /Length ${content.length} >>\nstream\n`,
      content,
      'endstream'
    ]);
  }

  const xrefOffset = byteLength;
  append(`xref\n0 ${maxObjectId + 1}\n`);
  append('0000000000 65535 f \n');
  for (let id = 1; id <= maxObjectId; id++) {
    append(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(objects, { type: 'application/pdf' });
}

async function canvasToJpegBytes(canvas, quality) {
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  return new Uint8Array(await blob.arrayBuffer());
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      const lastError = chrome.runtime.lastError;
      URL.revokeObjectURL(url);

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!downloadId) {
        reject(new Error(t('downloadMissing')));
        return;
      }
      resolve(downloadId);
    });
  });
}

function captureVisibleTabImage() {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 }, (dataUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('screenshotReadFailed')));
    img.src = src;
  });
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || '网页截图';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ==========================================
// 注入到目标网页的真实滚动辅助逻辑
// ==========================================
function installRenderedCaptureHelper() {
  window.__fullPageClipper = (() => {
    const state = {
      target: null,
      isWindowScroll: true,
      originalWindowX: window.scrollX,
      originalWindowY: window.scrollY,
      originalTargetX: 0,
      originalTargetY: 0,
      originalScrollBehavior: document.documentElement.style.scrollBehavior,
      repeatingElements: []
    };

    function findMainScrollableElement() {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const viewportArea = viewportWidth * viewportHeight;
      const root = document.scrollingElement || document.documentElement;
      const doc = document.documentElement;
      const body = document.body;
      const rootScrollWidth = Math.max(
        viewportWidth,
        doc.scrollWidth,
        body ? body.scrollWidth : 0,
        doc.offsetWidth,
        body ? body.offsetWidth : 0
      );
      const rootScrollHeight = Math.max(
        viewportHeight,
        doc.scrollHeight,
        body ? body.scrollHeight : 0,
        doc.offsetHeight,
        body ? body.offsetHeight : 0
      );
      const rootCanScrollY = rootScrollHeight > viewportHeight + 20;
      const rootCanScrollX = rootScrollWidth > viewportWidth + 20;
      const candidates = [];

      document.querySelectorAll('*').forEach((el) => {
        const style = window.getComputedStyle(el);
        const scrollableY = ['auto', 'scroll', 'overlay'].includes(style.overflowY);
        const scrollableX = ['auto', 'scroll', 'overlay'].includes(style.overflowX);
        const canScrollY = el.scrollHeight > el.clientHeight + 20;
        const canScrollX = el.scrollWidth > el.clientWidth + 20;

        if ((scrollableY || scrollableX) && (canScrollY || canScrollX) && el.clientHeight > 120) {
          const rect = el.getBoundingClientRect();
          const visibleWidth = Math.max(
            0,
            Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
          );
          const visibleHeight = Math.max(
            0,
            Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
          );
          const visibleArea = visibleWidth * visibleHeight;
          const widthCoverage = visibleWidth / Math.max(1, viewportWidth);
          const heightCoverage = visibleHeight / Math.max(1, viewportHeight);

          if (visibleArea < viewportArea * 0.25) return;
          if (widthCoverage < 0.45 || heightCoverage < 0.45) return;

          const scrollGain =
            Math.max(0, el.scrollHeight - el.clientHeight) +
            Math.max(0, el.scrollWidth - el.clientWidth);
          candidates.push({
            el,
            score: visibleArea + scrollGain * 0.25,
            coverage: visibleArea / Math.max(1, viewportArea)
          });
        }
      });

      if (rootCanScrollY || (rootCanScrollX && candidates.length === 0)) {
        return root;
      }

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0] ? candidates[0].el : root;
    }

    function makePositions(max, step) {
      const roundedMax = Math.max(0, Math.ceil(max));
      const roundedStep = Math.max(1, Math.floor(step));
      const positions = [0];

      for (let pos = roundedStep; pos < roundedMax; pos += roundedStep) {
        positions.push(pos);
      }

      if (positions[positions.length - 1] !== roundedMax) {
        positions.push(roundedMax);
      }

      return positions;
    }

    function rememberRepeatingElements() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const viewportArea = vw * vh;

      state.repeatingElements = [];
      document.querySelectorAll('body *').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'sticky') return;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;

        const rect = el.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area < 800 || area > viewportArea * 0.35) return;

        const touchesEdge =
          rect.top <= 24 ||
          rect.left <= 24 ||
          rect.right >= vw - 24 ||
          rect.bottom >= vh - 24;
        if (!touchesEdge) return;

        state.repeatingElements.push({
          el,
          cssText: el.style.cssText
        });
      });
    }

    function setRepeatingHidden(hidden) {
      state.repeatingElements.forEach(({ el }) => {
        if (hidden) {
          el.style.setProperty('visibility', 'hidden', 'important');
        } else {
          el.style.removeProperty('visibility');
        }
      });
    }

    async function waitForPaint(delay = 850) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, delay));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    async function prepare() {
      state.target = findMainScrollableElement();
      state.isWindowScroll =
        state.target === document.scrollingElement ||
        state.target === document.documentElement ||
        state.target === document.body;

      state.originalWindowX = window.scrollX;
      state.originalWindowY = window.scrollY;
      state.originalTargetX = state.isWindowScroll ? window.scrollX : state.target.scrollLeft;
      state.originalTargetY = state.isWindowScroll ? window.scrollY : state.target.scrollTop;
      state.originalScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      rememberRepeatingElements();

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let captureWidth = viewportWidth;
      let maxX = 0;
      let maxY = 0;
      let internalScrollMask = null;

      if (state.isWindowScroll) {
        const doc = document.documentElement;
        const body = document.body;
        captureWidth = Math.max(
          viewportWidth,
          doc.scrollWidth,
          body ? body.scrollWidth : 0,
          doc.offsetWidth,
          body ? body.offsetWidth : 0
        );
        const captureHeight = Math.max(
          viewportHeight,
          doc.scrollHeight,
          body ? body.scrollHeight : 0,
          doc.offsetHeight,
          body ? body.offsetHeight : 0
        );
        maxX = Math.max(0, captureWidth - viewportWidth);
        maxY = Math.max(0, captureHeight - viewportHeight);
      } else {
        captureWidth = viewportWidth;
        maxX = 0;
        maxY = Math.max(0, state.target.scrollHeight - state.target.clientHeight);
        const rect = state.target.getBoundingClientRect();
        internalScrollMask = {
          left: Math.max(0, rect.left),
          right: Math.min(viewportWidth, rect.right),
          top: Math.max(0, rect.top),
          bottom: Math.min(viewportHeight, rect.bottom),
          height: Math.max(1, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top))
        };
      }

      const xPositions = makePositions(maxX, viewportWidth);
      const yPositions = makePositions(
        maxY,
        state.isWindowScroll ? viewportHeight : state.target.clientHeight
      );

      if (state.isWindowScroll) {
        window.scrollTo(0, 0);
      } else {
        state.target.scrollTo(0, 0);
      }
      await waitForPaint(650);

      return {
        title: document.title,
        viewportWidth,
        viewportHeight,
        captureWidth,
        internalScrollMask,
        xPositions,
        yPositions,
        totalTiles: xPositions.length * yPositions.length
      };
    }

    async function scrollToTile({ x, y, hideRepeating }) {
      setRepeatingHidden(Boolean(hideRepeating));

      if (state.isWindowScroll) {
        window.scrollTo(x, y);
      } else {
        state.target.scrollTo(state.originalTargetX, y);
        window.scrollTo(0, 0);
      }

      await waitForPaint();
      return true;
    }

    async function restore() {
      setRepeatingHidden(false);
      state.repeatingElements.forEach(({ el, cssText }) => {
        el.style.cssText = cssText;
      });
      document.documentElement.style.scrollBehavior = state.originalScrollBehavior;

      if (state.isWindowScroll) {
        window.scrollTo(state.originalWindowX, state.originalWindowY);
      } else if (state.target) {
        state.target.scrollTo(state.originalTargetX, state.originalTargetY);
        window.scrollTo(state.originalWindowX, state.originalWindowY);
      }
      return true;
    }

    return { prepare, scrollToTile, restore };
  })();
}
