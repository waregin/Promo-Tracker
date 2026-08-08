/**
 * Minimal ambient declarations for the slice of the Chrome extension API this
 * project actually uses. Hand-written on purpose: it keeps `npm run typecheck`
 * dependency-free, and it doubles as a list of every platform call we make.
 * If you add an API here, you are widening the extension's surface — check it
 * against the permission set in manifest.json first.
 */

interface ChromeStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

interface ChromeTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
}

interface ChromeEvent<T extends (...args: any[]) => any> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
}

declare namespace chrome {
  namespace storage {
    const local: ChromeStorageArea;
    const sync: ChromeStorageArea;
    const session: ChromeStorageArea;
    const onChanged: ChromeEvent<
      (changes: Record<string, { oldValue?: any; newValue?: any }>, areaName: string) => void
    >;
  }

  namespace tabs {
    function get(tabId: number): Promise<ChromeTab>;
    function query(info: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
      url?: string | string[];
    }): Promise<ChromeTab[]>;
    function create(props: { url: string; active?: boolean }): Promise<ChromeTab>;
    function update(tabId: number, props: { active?: boolean }): Promise<ChromeTab>;
    const onUpdated: ChromeEvent<
      (tabId: number, changeInfo: { url?: string; status?: string }, tab: ChromeTab) => void
    >;
    const onActivated: ChromeEvent<(info: { tabId: number; windowId: number }) => void>;
    const onRemoved: ChromeEvent<(tabId: number) => void>;
  }

  namespace windows {
    function update(windowId: number, props: { focused?: boolean }): Promise<any>;
  }

  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
    function setBadgeTextColor(details: { tabId?: number; color: string }): Promise<void>;
    function setTitle(details: { tabId?: number; title: string }): Promise<void>;
  }

  namespace runtime {
    const id: string;
    function getURL(path: string): string;
    const lastError: { message?: string } | undefined;
    const onInstalled: ChromeEvent<(details: { reason: string }) => void>;
    const onStartup: ChromeEvent<() => void>;
  }
}
