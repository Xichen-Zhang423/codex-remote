(function artifactModule(global) {
  "use strict";

  const TEXT_LIMIT = 2 * 1024 * 1024;
  const IMAGE_LIMIT = 25 * 1024 * 1024;
  const PDF_LIMIT = 100 * 1024 * 1024;
  const TICKET_TIMEOUT_MS = 15_000;
  const PDF_MAX_DIMENSION = 8_192;
  const PDF_MAX_PIXELS = 16 * 1024 * 1024;
  const PDF_MIN_SCALE = 0.25;
  const RASTER_MIME = /^(?:image\/png|image\/jpeg|image\/gif|image\/webp)$/;

  function formatBytes(value) {
    const bytes = Number.isFinite(value) && value >= 0 ? value : 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function changeLabel(kind) {
    const labels = {
      created: "新文件",
      modified: "已修改",
      replaced: "已替换",
    };
    return labels[kind] || "变更";
  }

  function typeLabel(record) {
    const mime = typeof record?.mime === "string" ? record.mime : "";
    if (mime === "application/pdf") return "PDF";
    if (mime.startsWith("image/")) return `图片 · ${mime.slice(6).toUpperCase()}`;
    if (mime.startsWith("text/plain")) {
      const charset = /charset=([^;\s]+)/i.exec(mime)?.[1]?.toUpperCase();
      return charset ? `文本 · ${charset}` : "文本";
    }
    return mime || "未知类型";
  }

  function createController({
    elements,
    sendWire,
    backendOrigin,
    addTimelineEntry,
    openDrawer,
    closeDrawers,
    activateModal,
    deactivateModal,
  }) {
    const state = {
      epoch: 0,
      threadId: null,
      currentTurnId: null,
      requestId: null,
      revision: 0,
      records: new Map(),
      unseen: new Set(),
      tickets: new Map(),
      abortController: null,
      objectUrls: new Set(),
      complete: true,
      diagnostics: [],
      pdfLoadingTask: null,
      pdfDoc: null,
      renderTask: null,
      pdfRenderRun: 0,
      page: 1,
      pdfScale: 1.25,
      previewRun: 0,
      currentPreviewRecord: null,
      destroyed: false,
    };
    const listeners = [];

    function makeRequestId(prefix) {
      const suffix = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return `${prefix}-${suffix}`;
    }

    function listen(node, type, handler) {
      node.addEventListener(type, handler);
      listeners.push(() => node.removeEventListener(type, handler));
    }

    function stateLabel(record) {
      const labels = {
        ready: "可查看",
        too_large: "文件过大",
        blocked: "已拦截",
        failed: "处理失败",
        evicted: "已清理",
      };
      return labels[record.state] || "不可用";
    }

    function diagnosticHasError() {
      return state.diagnostics.some((item) => /failed|error|denied/i.test(String(item?.code || "")));
    }

    function setStatus(message, status = "ready") {
      elements.status.textContent = message;
      elements.status.dataset.state = status;
    }

    function noteUnseen(record, current) {
      if ((!current || Number(record.revision) > Number(current.revision)) && elements.drawer.hidden) {
        state.unseen.add(record.id);
      }
    }

    function merge(records) {
      for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record.id !== "string") continue;
        const current = state.records.get(record.id);
        if (!current || Number(record.revision) > Number(current.revision)) {
          state.records.set(record.id, record);
          noteUnseen(record, current);
        }
      }
    }

    function replaceSnapshot(records) {
      const previous = new Map(state.records);
      state.records.clear();
      const present = new Set();
      for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record.id !== "string") continue;
        present.add(record.id);
        const current = previous.get(record.id);
        const winner = current && Number(current.revision) > Number(record.revision) ? current : record;
        state.records.set(record.id, winner);
        noteUnseen(winner, current);
      }
      for (const id of state.unseen) if (!present.has(id)) state.unseen.delete(id);
    }

    function createRow(record) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `artifact-row state-${record.state || "unknown"}`;
      button.setAttribute("aria-label", `${record.displayName || record.relativePath || "未命名文件"}，${changeLabel(record.kind)}，${stateLabel(record)}`);

      const marker = document.createElement("span");
      marker.className = "artifact-row-marker";
      marker.setAttribute("aria-hidden", "true");

      const copy = document.createElement("span");
      copy.className = "artifact-row-copy";
      const name = document.createElement("strong");
      name.textContent = record.displayName || record.relativePath || "未命名文件";
      const path = document.createElement("small");
      path.textContent = record.relativePath || "工作区产出";
      const meta = document.createElement("span");
      meta.className = "artifact-row-meta";
      const kind = document.createElement("span");
      kind.textContent = changeLabel(record.kind);
      const size = document.createElement("span");
      size.textContent = formatBytes(record.size);
      const type = document.createElement("span");
      type.textContent = typeLabel(record);
      const availability = document.createElement("span");
      availability.textContent = stateLabel(record);
      meta.append(kind, type, size, availability);
      copy.append(name, path, meta);

      const arrow = document.createElement("span");
      arrow.className = "artifact-row-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "›";
      button.append(marker, copy, arrow);
      button.addEventListener("click", () => { void open(record); });
      return button;
    }

    function renderGroup(label, records, key) {
      if (!records.length) return;
      const section = document.createElement("section");
      section.className = "artifact-group";
      const heading = document.createElement("h3");
      heading.id = `artifact-group-${key}-title`;
      const title = document.createElement("span");
      title.textContent = label;
      const count = document.createElement("small");
      count.textContent = `${records.length} 项`;
      heading.append(title, count);
      section.setAttribute("aria-labelledby", heading.id);
      section.append(heading);
      for (const record of records) section.append(createRow(record));
      elements.list.append(section);
    }

    function render() {
      elements.list.replaceChildren();
      const records = [...state.records.values()].sort((a, b) => Number(b.revision) - Number(a.revision));
      const suffix = state.complete ? "" : " · 扫描未完整，可稍后刷新";
      if (records.length) {
        setStatus(`本次任务检测到 ${records.length} 个产出${suffix}`, diagnosticHasError() ? "error" : (state.complete ? "ready" : "partial"));
      } else {
        setStatus(`本轮暂未发现产出文件${suffix}`, diagnosticHasError() ? "error" : (state.complete ? "empty" : "partial"));
      }

      const currentRecords = state.currentTurnId
        ? records.filter((record) => record.turnId === state.currentTurnId)
        : [];
      const earlierRecords = state.currentTurnId
        ? records.filter((record) => record.turnId !== state.currentTurnId)
        : records;
      renderGroup("本轮", currentRecords, "current");
      renderGroup("较早产出", earlierRecords, "earlier");

      elements.badge.textContent = state.unseen.size > 99 ? "99+" : String(state.unseen.size);
      elements.badge.hidden = state.unseen.size === 0;
      elements.trigger.classList.toggle("has-unseen", state.unseen.size > 0);
    }

    function cancelTickets(reason) {
      for (const pending of state.tickets.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      state.tickets.clear();
    }

    function refresh() {
      if (state.destroyed || !state.threadId) {
        if (!state.threadId) setStatus("选择任务后查看产出。", "empty");
        return;
      }
      state.requestId = makeRequestId("artifacts");
      setStatus("正在加载任务产出…", "loading");
      elements.refresh.disabled = true;
      if (!sendWire({ type: "listArtifacts", requestId: state.requestId, threadId: state.threadId })) {
        state.requestId = null;
        elements.refresh.disabled = false;
        setStatus("连接尚未就绪，无法刷新产出。", "error");
      }
    }

    function onThreadChanged(threadId) {
      if (state.destroyed) return;
      cancelTickets("任务已切换");
      state.epoch += 1;
      state.threadId = typeof threadId === "string" && threadId ? threadId : null;
      state.currentTurnId = null;
      state.requestId = null;
      state.revision = 0;
      state.complete = true;
      state.diagnostics = [];
      state.records.clear();
      state.unseen.clear();
      closePreview();
      render();
      if (state.threadId) refresh();
    }

    function onHello(message) {
      if (state.destroyed) return;
      state.epoch += 1;
      state.requestId = null;
      cancelTickets("连接已更新");
      closePreview();
      elements.refresh.disabled = false;
      elements.trigger.hidden = !(Array.isArray(message.capabilities) && message.capabilities.includes("artifacts"));
      if (elements.trigger.hidden) closeDrawers();
    }

    function onHistoryRendered() {
      if (state.threadId) refresh();
    }

    function handleMessage(message) {
      if (!message || typeof message !== "object") return false;
      if (message.type === "artifact_snapshot") {
        if (message.requestId !== state.requestId || message.threadId !== state.threadId) return true;
        if (Number(message.revision) < state.revision) return true;
        state.requestId = null;
        elements.refresh.disabled = false;
        state.revision = Number(message.revision) || 0;
        state.complete = message.complete !== false;
        state.diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
        replaceSnapshot(message.records);
        render();
        return true;
      }
      if (message.type === "artifact_update") {
        if (message.threadId !== state.threadId || Number(message.revision) < state.revision) return true;
        if (typeof message.turnId === "string" && message.turnId) state.currentTurnId = message.turnId;
        state.revision = Number(message.revision) || state.revision;
        state.complete = message.complete !== false;
        state.diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
        merge(message.records);
        render();
        if (Array.isArray(message.records) && message.records.length) {
          const currentRecords = message.records.map((record) => state.records.get(record?.id)).filter(Boolean);
          if (currentRecords.length) addTimelineEntry(currentRecords, { complete: message.complete, diagnostics: message.diagnostics });
        }
        return true;
      }
      if (message.type === "artifact_access") {
        const pending = state.tickets.get(message.requestId);
        if (!pending) return true;
        state.tickets.delete(message.requestId);
        clearTimeout(pending.timer);
        if (pending.epoch !== state.epoch
            || message.artifactId !== pending.artifactId
            || message.purpose !== pending.purpose) {
          pending.reject(new Error("产出授权与当前请求不匹配"));
        } else {
          pending.resolve(message);
        }
        return true;
      }
      if (message.type === "artifact_error") {
        const pending = state.tickets.get(message.requestId);
        if (pending) {
          state.tickets.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error(message.message || "无法获取产出授权"));
          return true;
        }
        if (message.requestId === state.requestId) {
          state.requestId = null;
          elements.refresh.disabled = false;
          state.complete = false;
          state.diagnostics = [{ code: message.code, message: message.message }];
          render();
        }
        return true;
      }
      return false;
    }

    function ticket(record, purpose) {
      if (state.destroyed) return Promise.reject(new Error("产出界面已关闭"));
      if (!record || !["preview", "download"].includes(purpose)) return Promise.reject(new Error("产出请求无效"));
      const id = makeRequestId("artifact-ticket");
      let pending;
      const promise = new Promise((resolve, reject) => {
        pending = { resolve, reject, epoch: state.epoch, artifactId: record.id, purpose, timer: null };
        state.tickets.set(id, pending);
      });
      pending.timer = setTimeout(() => {
        if (state.tickets.get(id) !== pending) return;
        state.tickets.delete(id);
        pending.reject(new Error("产出授权等待超时，请重试"));
      }, TICKET_TIMEOUT_MS);
      if (!sendWire({ type: "createArtifactTicket", requestId: id, artifactId: record.id, purpose })) {
        state.tickets.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("连接尚未就绪"));
      }
      return promise;
    }

    function isCancellation(error) {
      return error?.name === "AbortError"
        || error?.name === "RenderingCancelledException"
        || /已切换|已更新|已关闭|已替换|cancel|abort|destroy|terminated/i.test(String(error?.message || ""));
    }

    function assertPreviewCurrent(record, previewEpoch, previewRun) {
      if (previewEpoch !== state.epoch
          || previewRun !== state.previewRun
          || state.currentPreviewRecord?.id !== record.id
          || state.destroyed) {
        const error = new Error("预览已取消");
        error.name = "AbortError";
        throw error;
      }
    }

    function assertPdfRenderCurrent(record, previewEpoch, previewRun, renderRun) {
      assertPreviewCurrent(record, previewEpoch, previewRun);
      if (renderRun !== state.pdfRenderRun) {
        const error = new Error("PDF 页面渲染已取消");
        error.name = "AbortError";
        throw error;
      }
    }

    function showPreviewError(error) {
      const panel = document.createElement("div");
      panel.className = "artifact-preview-message is-error";
      const title = document.createElement("strong");
      title.textContent = "暂时无法预览";
      const detail = document.createElement("p");
      detail.textContent = error?.message || "读取产出时发生错误，请重试或下载文件。";
      panel.append(title, detail);
      elements.body.replaceChildren(panel);
    }

    async function runAction(action, button = null) {
      if (button) {
        button.disabled = true;
        button.classList.add("is-loading");
      }
      try {
        return await action();
      } catch (error) {
        if (!isCancellation(error)) {
          if (!elements.preview.hidden && state.currentPreviewRecord) showPreviewError(error);
          else setStatus(error?.message || "产出操作失败，请稍后重试。", "error");
        }
        return undefined;
      } finally {
        if (button?.isConnected) {
          button.disabled = false;
          button.classList.remove("is-loading");
        }
      }
    }

    async function fetchGrant(record, purpose, previewEpoch, previewRun, init = {}) {
      const message = await ticket(record, purpose);
      if (purpose === "preview") assertPreviewCurrent(record, previewEpoch, previewRun);
      const base = backendOrigin();
      const url = new URL(message.url, base);
      if (url.origin !== base.origin) throw new Error("产出地址来源不匹配");
      state.abortController?.abort();
      state.abortController = new AbortController();
      const response = await fetch(url, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        signal: state.abortController.signal,
      });
      if (purpose === "preview") assertPreviewCurrent(record, previewEpoch, previewRun);
      if (!response.ok && response.status !== 206) throw new Error(`产出读取失败 (${response.status})`);
      return response;
    }

    async function showText(record, previewEpoch, previewRun) {
      const response = await fetchGrant(record, "preview", previewEpoch, previewRun, {
        headers: { Range: "bytes=0-2097151" },
      });
      const contentType = response.headers.get("Content-Type") || record.mime || "";
      const charset = /charset=(utf-8|utf-16le|utf-16be)/i.exec(contentType)?.[1]?.toLowerCase() || "utf-8";
      const bytes = await response.arrayBuffer();
      assertPreviewCurrent(record, previewEpoch, previewRun);
      const pre = document.createElement("pre");
      pre.textContent = new TextDecoder(charset).decode(bytes);
      elements.body.replaceChildren(pre);
      if (record.size > bytes.byteLength) elements.meta.textContent += " · 在线预览已截断，可下载完整文件";
    }

    async function showImage(record, previewEpoch, previewRun) {
      const response = await fetchGrant(record, "preview", previewEpoch, previewRun);
      const blob = await response.blob();
      assertPreviewCurrent(record, previewEpoch, previewRun);
      const url = URL.createObjectURL(blob);
      state.objectUrls.add(url);
      const image = document.createElement("img");
      image.alt = record.displayName || "任务产出图片";
      image.src = url;
      image.className = "artifact-preview-image";
      elements.body.replaceChildren(image);
    }

    async function showPdf(record, previewEpoch, previewRun) {
      const pdfjsLib = await import("./vendor/pdfjs/pdf.min.mjs");
      assertPreviewCurrent(record, previewEpoch, previewRun);
      pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
      const response = await fetchGrant(record, "preview", previewEpoch, previewRun);
      const bytes = await response.arrayBuffer();
      assertPreviewCurrent(record, previewEpoch, previewRun);
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
      state.pdfLoadingTask = loadingTask;
      let pdfDoc;
      try {
        pdfDoc = await loadingTask.promise;
      } finally {
        if (state.pdfLoadingTask === loadingTask) state.pdfLoadingTask = null;
      }
      if (previewEpoch !== state.epoch || previewRun !== state.previewRun) {
        try { await Promise.resolve(pdfDoc.destroy()).catch(() => {}); } catch { /* already destroyed */ }
        assertPreviewCurrent(record, previewEpoch, previewRun);
      }
      state.pdfDoc = pdfDoc;
      state.page = 1;
      state.pdfScale = 1.25;
      await renderPdfPage(previewEpoch, previewRun);
    }

    function boundedPdfViewport(page, requestedScale) {
      const baseViewport = page.getViewport({ scale: 1 });
      if (!Number.isFinite(baseViewport.width)
          || !Number.isFinite(baseViewport.height)
          || baseViewport.width <= 0
          || baseViewport.height <= 0
          || !Number.isFinite(requestedScale)
          || requestedScale <= 0) {
        throw new Error("PDF 页面尺寸超出安全预览范围");
      }
      const dimensionScale = Math.min(
        PDF_MAX_DIMENSION / baseViewport.width,
        PDF_MAX_DIMENSION / baseViewport.height,
      );
      const pixelScale = Math.sqrt(PDF_MAX_PIXELS / (baseViewport.width * baseViewport.height));
      let effectiveScale = Math.min(requestedScale, dimensionScale, pixelScale);
      if (!Number.isFinite(effectiveScale) || effectiveScale < PDF_MIN_SCALE) {
        throw new Error("PDF 页面尺寸超出安全预览范围");
      }
      let viewport = page.getViewport({ scale: effectiveScale });
      let width = Math.ceil(viewport.width);
      let height = Math.ceil(viewport.height);
      if (width > PDF_MAX_DIMENSION || height > PDF_MAX_DIMENSION || width * height > PDF_MAX_PIXELS) {
        const correction = Math.min(
          PDF_MAX_DIMENSION / width,
          PDF_MAX_DIMENSION / height,
          Math.sqrt(PDF_MAX_PIXELS / (width * height)),
        ) * 0.999;
        effectiveScale *= correction;
        if (!Number.isFinite(effectiveScale) || effectiveScale < PDF_MIN_SCALE) {
          throw new Error("PDF 页面尺寸超出安全预览范围");
        }
        viewport = page.getViewport({ scale: effectiveScale });
        width = Math.ceil(viewport.width);
        height = Math.ceil(viewport.height);
      }
      if (!Number.isFinite(viewport.width)
          || !Number.isFinite(viewport.height)
          || !Number.isSafeInteger(width)
          || !Number.isSafeInteger(height)
          || width <= 0
          || height <= 0
          || width > PDF_MAX_DIMENSION
          || height > PDF_MAX_DIMENSION
          || width * height > PDF_MAX_PIXELS) {
        throw new Error("PDF 页面尺寸超出安全预览范围");
      }
      return { viewport, width, height, effectiveScale };
    }

    async function renderPdfPage(previewEpoch = state.epoch, previewRun = state.previewRun) {
      const renderRun = ++state.pdfRenderRun;
      try { state.renderTask?.cancel(); } catch { /* cancellation is best effort */ }
      state.renderTask = null;
      const pdfDoc = state.pdfDoc;
      const record = state.currentPreviewRecord;
      if (!pdfDoc || !record) return;
      const pageNumber = state.page;
      const page = await pdfDoc.getPage(pageNumber);
      assertPdfRenderCurrent(record, previewEpoch, previewRun, renderRun);
      const { viewport, width, height, effectiveScale } = boundedPdfViewport(page, state.pdfScale);
      assertPdfRenderCurrent(record, previewEpoch, previewRun, renderRun);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.setAttribute("aria-label", `${record.displayName || "PDF"} 第 ${pageNumber} 页`);
      elements.body.replaceChildren(canvas);
      state.pdfScale = effectiveScale;
      let renderTask = null;
      try {
        renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
        state.renderTask = renderTask;
        await renderTask.promise;
        assertPdfRenderCurrent(record, previewEpoch, previewRun, renderRun);
        elements.pageStatus.textContent = `${pageNumber} / ${pdfDoc.numPages}`;
        updatePdfControls();
      } catch (error) {
        canvas.width = 0;
        canvas.height = 0;
        if (!isCancellation(error)) throw error;
      } finally {
        if (renderTask && state.renderTask === renderTask) state.renderTask = null;
      }
    }

    function previewKind(record) {
      if (record?.state !== "ready") return null;
      if (RASTER_MIME.test(record.mime) && record.size <= IMAGE_LIMIT) return "image";
      if (typeof record.mime === "string" && record.mime.startsWith("text/plain;") && record.size <= TEXT_LIMIT) return "text";
      if (record.mime === "application/pdf" && record.size <= PDF_LIMIT) return "pdf";
      return null;
    }

    function updatePdfControls() {
      const isPdf = Boolean(state.pdfDoc);
      elements.previousPage.hidden = !isPdf;
      elements.nextPage.hidden = !isPdf;
      elements.fit.hidden = !isPdf;
      elements.pageStatus.hidden = !isPdf;
      elements.previousPage.disabled = !isPdf || state.page <= 1;
      elements.nextPage.disabled = !isPdf || state.page >= (state.pdfDoc?.numPages || 0);
      if (!isPdf) elements.pageStatus.textContent = "";
    }

    function releasePreviewResources({ deactivate = true } = {}) {
      cancelTickets(deactivate ? "预览已关闭" : "预览已替换");
      state.previewRun += 1;
      state.pdfRenderRun += 1;
      state.abortController?.abort();
      state.abortController = null;
      try { state.renderTask?.cancel(); } catch { /* cancellation is best effort */ }
      state.renderTask = null;
      if (state.pdfLoadingTask) {
        const loadingTask = state.pdfLoadingTask;
        state.pdfLoadingTask = null;
        try { void Promise.resolve(loadingTask.destroy()).catch(() => {}); } catch { /* already destroyed */ }
      }
      if (state.pdfDoc) {
        const pdfDoc = state.pdfDoc;
        state.pdfDoc = null;
        try { void Promise.resolve(pdfDoc.destroy()).catch(() => {}); } catch { /* already destroyed */ }
      }
      state.currentPreviewRecord = null;
      for (const url of state.objectUrls) URL.revokeObjectURL(url);
      state.objectUrls.clear();
      for (const canvas of elements.body.querySelectorAll("canvas")) {
        canvas.width = 0;
        canvas.height = 0;
      }
      elements.body.replaceChildren();
      elements.meta.textContent = "";
      updatePdfControls();
      if (deactivate) deactivateModal(elements.preview);
    }

    function closePreview() {
      releasePreviewResources();
    }

    async function openImpl(record) {
      if (record?.state !== "ready") {
        setStatus("该产出当前不可用。", "error");
        return;
      }
      const kind = previewKind(record);
      if (!kind) {
        cancelTickets("操作已替换");
        await downloadImpl(record);
        return;
      }

      releasePreviewResources({ deactivate: false });
      state.currentPreviewRecord = record;
      const previewEpoch = state.epoch;
      const previewRun = state.previewRun;
      elements.title.textContent = record.displayName || "任务产出";
      elements.meta.textContent = `${record.relativePath || "工作区产出"} · ${formatBytes(record.size)}`;
      const loading = document.createElement("div");
      loading.className = "artifact-preview-message is-loading";
      const heading = document.createElement("strong");
      heading.textContent = "正在安全加载预览";
      const hint = document.createElement("p");
      hint.textContent = "预览使用一次性短授权，不会携带登录凭据。";
      loading.append(heading, hint);
      elements.body.replaceChildren(loading);
      updatePdfControls();
      activateModal(elements.preview, elements.close);

      if (kind === "text") await showText(record, previewEpoch, previewRun);
      else if (kind === "pdf") await showPdf(record, previewEpoch, previewRun);
      else await showImage(record, previewEpoch, previewRun);
    }

    function open(record) {
      return runAction(() => openImpl(record));
    }

    async function downloadImpl(record) {
      if (record?.state !== "ready") throw new Error("该产出当前不可下载");
      const downloadEpoch = state.epoch;
      const message = await ticket(record, "download");
      if (downloadEpoch !== state.epoch) throw new Error("任务已切换");
      const base = backendOrigin();
      const url = new URL(message.url, base);
      if (url.origin !== base.origin) throw new Error("产出地址来源不匹配");
      global.location.assign(url.href);
    }

    function download(record) {
      return runAction(() => downloadImpl(record), elements.download);
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      cancelTickets("产出界面已关闭");
      closePreview();
      for (const remove of listeners.splice(0)) remove();
    }

    function showAll() {
      if (state.destroyed || elements.trigger.hidden) return;
      state.unseen.clear();
      render();
      openDrawer(elements.drawer);
    }

    listen(elements.refresh, "click", refresh);
    listen(elements.trigger, "click", showAll);
    listen(elements.close, "click", closePreview);
    listen(elements.previousPage, "click", () => {
      if (!state.pdfDoc || state.page <= 1) return;
      state.page -= 1;
      void runAction(() => renderPdfPage(), elements.previousPage);
    });
    listen(elements.nextPage, "click", () => {
      if (!state.pdfDoc || state.page >= state.pdfDoc.numPages) return;
      state.page += 1;
      void runAction(() => renderPdfPage(), elements.nextPage);
    });
    listen(elements.fit, "click", () => {
      if (!state.pdfDoc) return;
      state.pdfScale = Math.max(0.5, Math.min(3, (elements.body.clientWidth - 32) / 612));
      void runAction(() => renderPdfPage(), elements.fit);
    });
    listen(elements.download, "click", () => {
      if (state.currentPreviewRecord) void download(state.currentPreviewRecord);
    });

    updatePdfControls();
    render();

    return Object.freeze({
      onHello,
      onThreadChanged,
      onHistoryRendered,
      handleMessage,
      refresh,
      open,
      download,
      showAll,
      closePreview,
      destroy,
    });
  }

  global.CodexArtifactUI = Object.freeze({ createController, formatBytes, changeLabel, typeLabel });
})(globalThis);
