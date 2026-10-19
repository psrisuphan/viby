interface BrowserTestTrace {
  invokes: string[];
  emittedEvents: string[];
}

type BrowserTestWindow = Window & {
  __vibyBrowserTestTrace?: BrowserTestTrace;
};

const serverTrace: BrowserTestTrace = {
  invokes: [],
  emittedEvents: [],
};
const browserWindow =
  typeof window === "undefined" ? null : (window as BrowserTestWindow);

if (browserWindow && !browserWindow.__vibyBrowserTestTrace) {
  browserWindow.__vibyBrowserTestTrace = serverTrace;
}

export const browserTestTrace =
  browserWindow?.__vibyBrowserTestTrace ?? serverTrace;
