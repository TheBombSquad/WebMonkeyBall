type RenderPerfDebugOptions = {
  storageKey: string;
};

export function createRenderPerfDebugState(options: RenderPerfDebugOptions) {
  function isRenderPerfDebugEnabled() {
    const globalFlag = (window as any).RENDER_PERF_DEBUG;
    if (globalFlag !== undefined) {
      return !!globalFlag;
    }
    try {
      return localStorage.getItem(options.storageKey) === '1';
    } catch {
      return false;
    }
  }

  function setRenderPerfDebugEnabled(enabled: boolean) {
    (window as any).RENDER_PERF_DEBUG = enabled;
    try {
      localStorage.setItem(options.storageKey, enabled ? '1' : '0');
    } catch {
      // Ignore storage issues.
    }
  }

  (window as any).setRenderPerfDebug = setRenderPerfDebugEnabled;

  return {
    isRenderPerfDebugEnabled,
    setRenderPerfDebugEnabled,
  };
}
