interface BrowserTestTrace {
	invokes: string[];
	emittedEvents: string[];
}

type BrowserTestWindow = Window & {
	__vibyBrowserTestTrace?: BrowserTestTrace;
};

const browserWindow = window as BrowserTestWindow;

export const browserTestTrace =
	(browserWindow.__vibyBrowserTestTrace ??= {
		invokes: [],
		emittedEvents: [],
	});
