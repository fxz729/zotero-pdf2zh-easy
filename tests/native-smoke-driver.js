// NATIVE TEST ONLY. Injected into a scratch XPI, never the release build.
(async () => {
    const reportPath = __NATIVE_REPORT__;
    const report = { testOnly: true, startedAt: new Date().toISOString(), ok: false, stages: [] };
    const clock = Date.now();
    const checkpoint = async (stage) => {
        report.stages.push({ stage, seconds: (Date.now() - clock) / 1000 });
        await IOUtils.writeUTF8(reportPath, JSON.stringify(report, null, 2));
    };
    const captureCard = async (win, name) => {
        const card = win.document.querySelector('.pdf2zh-easy-card');
        if (!card) throw new Error('Native progress card was not created.');
        const rect = card.getBoundingClientRect();
        const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        canvas.width = Math.ceil(rect.width + 20); canvas.height = Math.ceil(rect.height + 20);
        const context = canvas.getContext('2d');
        if (!context || typeof context.drawWindow !== 'function') return false;
        context.drawWindow(win, Math.max(0, rect.x - 10), Math.max(0, rect.y - 10), canvas.width, canvas.height, 'rgb(255,255,255)');
        const encoded = canvas.toDataURL('image/png').split(',')[1];
        const binary = win.atob(encoded);
        await IOUtils.write(PathUtils.join(PathUtils.parent(reportPath), name), Uint8Array.from(binary, c => c.charCodeAt(0)));
        return true;
    };
    try {
        await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
        await Zotero.Promise.delay(1500);
        await checkpoint('native-zotero-ready');
        report.globalTypes = { TextDecoder: typeof TextDecoder, TextEncoder: typeof TextEncoder, Headers: typeof Headers, Response: typeof Response, AbortController: typeof AbortController, URL: typeof URL, fetch: typeof fetch, setTimeout: typeof setTimeout };
        await new Promise(resolve => {
            const probe = report.nativeChannelDiagnostic = { step: 'import' };
            try {
                const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
                probe.step = 'channel';
                const channel = NetUtil.newChannel({ uri: rootURI + 'content/runtime/runtime-manifest.json', loadUsingSystemPrincipal: true });
                probe.step = 'fetch';
                NetUtil.asyncFetch(channel, (stream, status) => {
                    let binary;
                    try {
                        probe.status = status;
                        probe.success = Components.isSuccessCode(status);
                        probe.step = 'available';
                        const length = stream.available(); probe.length = String(length); probe.lengthType = typeof length;
                        probe.step = 'binary-create';
                        binary = Components.classes['@mozilla.org/binaryinputstream;1'].createInstance(Components.interfaces.nsIBinaryInputStream);
                        probe.step = 'binary-attach'; binary.setInputStream(stream);
                        probe.step = 'binary-read'; const bytes = new Uint8Array(binary.readByteArray(Number(length))); probe.bytes = bytes.byteLength;
                        probe.step = 'remaining';
                        try { probe.remaining = String(stream.available()); }
                        catch (error) {
                            if (error.result !== Components.results.NS_BASE_STREAM_CLOSED) throw error;
                            probe.remaining = '0'; probe.normalClosedEOF = true;
                        }
                        probe.step = 'decode';
                        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                        probe.schemaVersion = data.version; probe.schemaFiles = data.files?.length;
                        probe.step = 'complete';
                    } catch (error) { probe.error = String(error).slice(0, 280); }
                    finally { try { if (binary) binary.close(); else stream?.close(); } catch {} resolve(); }
                });
            } catch (error) { probe.error = String(error).slice(0, 280); resolve(); }
        });
        try {
            const bundled = await ManagedRuntime.bundledBytes(rootURI + 'content/runtime/runtime-manifest.json', 65536);
            report.bundledManifestBytes = bundled.byteLength;
            const decoded = new (Zotero.getMainWindow().TextDecoder)('utf-8', { fatal: true }).decode(bundled);
            const parsed = JSON.parse(decoded);
            report.nativeManifestShape = { version: parsed.version, fileCount: Array.isArray(parsed.files) ? parsed.files.length : -1 };
        } catch (error) { report.nativeManifestReadDiagnostic = String(error).slice(0, 200); }
        report.firstRunInstalled = await ManagedRuntime.isInstalled();
        if (report.firstRunInstalled) throw new Error('A genuinely empty test runtime is required.');
        let pane;
        for (let i = 0; i < 100 && !pane; i++) {
            pane = Zotero.PreferencePanes.pluginPanes.find(value => value.pluginID === 'pdf2zh-easy@fxz729');
            if (!pane) await Zotero.Promise.delay(100);
        }
        if (!pane) throw new Error('Native settings pane was not registered.');
        const preferences = Zotero.Utilities.Internal.openPreferences(pane.id);
        preferences.minimize();
        let settings;
        for (let i = 0; i < 100 && !settings; i++) {
            settings = preferences.document.querySelector('.pdf2zh-easy-settings');
            if (!settings) await Zotero.Promise.delay(100);
        }
        if (!settings) throw new Error('Friendly settings did not load in native Zotero.');
        report.settingsSectionCount = settings.querySelectorAll('section').length;
        report.firstRunApiUrlEmpty = preferences.document.getElementById('zotero-prefpane-pdf2zhEasy-easy-url').value === '';
        report.firstRunApiKeyEmpty = preferences.document.getElementById('zotero-prefpane-pdf2zhEasy-easy-key').value === '';
        const prefCanvas = preferences.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        prefCanvas.width = preferences.innerWidth; prefCanvas.height = preferences.innerHeight;
        const prefContext = prefCanvas.getContext('2d');
        if (typeof prefContext?.drawWindow === 'function') {
            prefContext.drawWindow(preferences, 0, 0, preferences.innerWidth, preferences.innerHeight, 'rgb(255,255,255)');
            const binary = preferences.atob(prefCanvas.toDataURL('image/png').split(',')[1]);
            await IOUtils.write(PathUtils.join(PathUtils.parent(reportPath), 'native-settings.png'), Uint8Array.from(binary, c => c.charCodeAt(0)));
            report.nativeSettingsScreenshot = true;
        }
        preferences.close();
        await checkpoint('native-settings-verified');
        await ManagedRuntime.install(true);
        report.runtimeRoot = ManagedRuntime.root;
        report.managedPython = ManagedRuntime.python;
        report.installed = await ManagedRuntime.isInstalled();
        if (!report.installed) throw new Error('Guided installation did not produce a valid ready marker.');
        await checkpoint('guided-install-complete');
        await ManagedRuntime.ensureReady();
        await Zotero.Promise.delay(1800);
        report.probeAfterHelperExit = await runQuiet(ManagedRuntime.python,
            ['-X', 'utf8', '-u', PathUtils.join(ManagedRuntime.root, 'runtime', 'bootstrap.py'), 'probe'], 5000, ManagedRuntime.environment());
        if (report.probeAfterHelperExit !== 0) throw new Error('Service did not survive its short-lived readiness helper.');
        await checkpoint('service-survived-helper-exit');
        const win = Zotero.getMainWindow();
        const popup = JobProgressPopup.open(['PDF2zh Easy synthetic progress.pdf']);
        popup.updateFile({ phase: 'running', fileName: 'PDF2zh Easy synthetic progress.pdf', endpoint: 'translate', current: 1, total: 1, percent: 22, detail: 'DetectScannedFile' });
        await Zotero.Promise.delay(350);
        report.cardCount = win.document.querySelectorAll('.pdf2zh-easy-card').length;
        report.progressScenario = 'Synthetic UI events, not an API translation';
        report.nativeCardScreenshot = await captureCard(win, 'native-progress-card.png');
        let nativeWindows = 0;
        const windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            const window = windows.getNext();
            if (String(window.document?.documentURI || '').includes('progressWindow')) nativeWindows++;
        }
        report.nativeProgressWindowCount = nativeWindows;
        popup.updateFile({ phase: 'file-done', fileName: 'PDF2zh Easy synthetic progress.pdf', endpoint: 'translate', current: 1, total: 1, percent: 100 });
        popup.complete(1, 0);
        await Zotero.Promise.delay(8300);
        report.cardRemovedAfterSuccess = win.document.querySelectorAll('.pdf2zh-easy-card').length === 0;
        report.ok = report.installed && report.settingsSectionCount === 4 && report.firstRunApiUrlEmpty && report.firstRunApiKeyEmpty && report.probeAfterHelperExit === 0 && report.cardCount === 1 && nativeWindows === 0 && report.cardRemovedAfterSuccess;
        await checkpoint('native-card-lifecycle-complete');
    } catch (error) {
        // This empty test profile contains no provider credentials or user papers.
        report.error = String(error).slice(0, 400);
    }
    report.finishedAt = new Date().toISOString();
    report.seconds = (Date.now() - clock) / 1000;
    await IOUtils.writeUTF8(reportPath, JSON.stringify(report, null, 2));
    await Zotero.Promise.delay(500);
    // Only the disposable profile launched for this driver is affected.
    Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
})();
