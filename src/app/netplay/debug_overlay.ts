export type NetplayDebugOverlay = {
  hide: () => void;
  show: (warning: string | null, lines: string[]) => void;
};

export type FrameStatsOverlay = {
  hide: () => void;
  show: (line: string) => void;
};

function createOverlayRoot(parent: HTMLElement, id: string, side: 'left' | 'right') {
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.style.position = 'fixed';
  wrap.style.top = '120px';
  wrap.style.zIndex = '10000';
  wrap.style.color = '#ffffff';
  wrap.style.font = '12px/1.4 system-ui, sans-serif';
  wrap.style.whiteSpace = 'pre';
  wrap.style.pointerEvents = 'none';
  wrap.style.textShadow = '0 1px 2px rgba(0,0,0,0.7)';
  wrap.style.background = 'rgba(0, 0, 0, 0.5)';
  wrap.style.padding = '8px 10px';
  wrap.style.borderRadius = '6px';
  wrap.style.display = 'none';
  if (side === 'left') {
    wrap.style.left = '12px';
  } else {
    wrap.style.right = '12px';
    wrap.style.textAlign = 'right';
  }
  parent.appendChild(wrap);
  return wrap;
}

export function createNetplayDebugOverlay(parent: HTMLElement = document.body): NetplayDebugOverlay {
  const wrap = createOverlayRoot(parent, 'netplay-debug', 'left');
  const warningEl = document.createElement('div');
  const infoEl = document.createElement('div');

  warningEl.style.color = '#ff6666';
  warningEl.style.fontWeight = '600';
  warningEl.style.marginBottom = '4px';
  infoEl.style.whiteSpace = 'pre';

  wrap.append(warningEl, infoEl);

  return {
    hide: () => {
      wrap.style.display = 'none';
    },
    show: (warning, lines) => {
      warningEl.textContent = warning ?? '';
      infoEl.textContent = lines.join('\n');
      wrap.style.display = 'block';
    },
  };
}

export function createFrameStatsOverlay(parent: HTMLElement = document.body): FrameStatsOverlay {
  const wrap = createOverlayRoot(parent, 'frame-stats-debug', 'right');
  const infoEl = document.createElement('div');
  infoEl.style.whiteSpace = 'pre';
  wrap.append(infoEl);

  return {
    hide: () => {
      wrap.style.display = 'none';
    },
    show: (line) => {
      infoEl.textContent = line;
      wrap.style.display = 'block';
    },
  };
}
