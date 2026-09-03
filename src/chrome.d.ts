/* ---------------------------------------------------------------------------
   The slice of the Chrome extension API this tool uses, hand-declared.

   `@types/chrome` is ~20k lines describing an API surface we touch in four
   places, and the family rule is that anything writable in a few hundred lines
   gets written. These match the HAR shape `chrome.devtools.network` hands back.
   --------------------------------------------------------------------------- */

interface HarNameValue { name: string; value: string }

interface HarRequest {
  method: string;
  url: string;
  headers: HarNameValue[];
  queryString?: HarNameValue[];
  postData?: { mimeType?: string; text?: string };
}

interface HarResponse {
  status: number;
  statusText?: string;
  headers: HarNameValue[];
  content?: { mimeType?: string; size?: number; text?: string };
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  /** Chrome's addition to HAR: pulls the body in on demand. */
  getContent(callback: (content: string | null, encoding: string) => void): void;
}

declare namespace chrome {
  namespace devtools {
    namespace panels {
      function create(
        title: string, iconPath: string, pagePath: string,
        callback?: (panel: unknown) => void,
      ): void;
    }
    namespace network {
      const onRequestFinished: {
        addListener(cb: (entry: HarEntry) => void): void;
        removeListener(cb: (entry: HarEntry) => void): void;
      };
      const onNavigated: {
        addListener(cb: (url: string) => void): void;
      };
      function getHAR(callback: (har: { entries: HarEntry[] }) => void): void;
    }
    namespace inspectedWindow {
      const tabId: number;
      /** Runs an expression in the inspected page and hands back its value. */
      function eval(
        expression: string,
        callback?: (result: unknown, info?: { isError?: boolean; isException?: boolean; value?: string; description?: string }) => void,
      ): void;
      /** `injectedScript` runs before any of the page's own scripts. */
      function reload(options?: { ignoreCache?: boolean; injectedScript?: string }): void;
    }
  }
}
