import { webview } from '@kit.ArkWeb';

// Replace these placeholders before building when you want scan-free startup.
// ORIGIN must contain scheme and host only. RZ is the public /current endpoint.
const ORIGIN: string = 'https://codex-remote.invalid';
const TOKEN: string = 'PASTE_YOUR_TOKEN_HERE';
const RZ: string = 'https://your-worker.example.workers.dev/current?deviceId=YOUR_DEVICE_ID';

const STORAGE_KEY: string = 'codex-remote.backend.v1';
const LOCAL_RESOURCE_ORIGIN: string = 'resource://rawfile/';
const SEED_JS: string =
  "window.Capacitor=window.Capacitor||{platform:'harmony'};" +
  "try{" +
  "var token=" + JSON.stringify(TOKEN) + ";" +
  "if(token.indexOf('PASTE_')!==0&&!localStorage.getItem('" + STORAGE_KEY + "')){" +
  "localStorage.setItem('" + STORAGE_KEY + "',JSON.stringify({" +
  "origin:" + JSON.stringify(ORIGIN) + ",token:token,rz:" + JSON.stringify(RZ) + "}));" +
  "}" +
  "}catch(error){}";

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .mixedMode(MixedMode.All)
        .cacheMode(CacheMode.Default)
        .darkMode(WebDarkMode.On)
        .javaScriptOnDocumentStart([{ script: SEED_JS, scriptRules: ['resource://'] }])
        .onLoadIntercept((event) => {
          const url: string = event.data.getRequestUrl();
          return !url.startsWith(LOCAL_RESOURCE_ORIGIN);
        })
        .onPermissionRequest((event) => {
          if (event) {
            const origin: string = event.request.getOrigin();
            const requested: Array<string> = event.request.getAccessibleResource();
            const camera: Array<string> = requested.filter((resource: string) => {
              return resource === 'TYPE_VIDEO_CAPTURE';
            });
            if (origin.startsWith(LOCAL_RESOURCE_ORIGIN) && camera.length > 0) {
              event.request.grant(camera);
            } else {
              event.request.deny();
            }
          }
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
