// Root Cellar Labels clip art. Every picture here was drawn for this app and is free to use (CC0).
// Black on transparent so it prints crisply on thermal label printers. 64x64 viewBox.
'use strict';
(function () {
  const S = 'fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"';
  const F = 'fill="#000"';
  const art = {
    // faces
    smile: ['Smiley', `<circle cx="32" cy="32" r="27" ${S}/><circle cx="23" cy="26" r="3.5" ${F}/><circle cx="41" cy="26" r="3.5" ${F}/><path d="M19 38c4 7 9 10 13 10s9-3 13-10" ${S}/>`],
    grin: ['Big grin', `<circle cx="32" cy="32" r="27" ${S}/><path d="M20 25c2-3 5-3 7 0M37 25c2-3 5-3 7 0" ${S}/><path d="M17 35h30c-1 9-7 15-15 15s-14-6-15-15z" ${F}/>`],
    wink: ['Wink', `<circle cx="32" cy="32" r="27" ${S}/><circle cx="23" cy="26" r="3.5" ${F}/><path d="M37 27h8" ${S}/><path d="M20 39c4 6 8 8 12 8s8-2 12-8" ${S}/>`],
    love: ['Heart eyes', `<circle cx="32" cy="32" r="27" ${S}/><path d="M23 30l-5-5a3 3 0 0 1 5-4 3 3 0 0 1 5 4zM41 30l-5-5a3 3 0 0 1 5-4 3 3 0 0 1 5 4z" ${F}/><path d="M20 39c4 6 8 8 12 8s8-2 12-8" ${S}/>`],
    cool: ['Sunglasses', `<circle cx="32" cy="32" r="27" ${S}/><path d="M12 24h40v4c0 5-3 8-8 8h-2c-4 0-6-3-7-6h-6c-1 3-3 6-7 6h-2c-5 0-8-3-8-8z" ${F}/><path d="M23 44c6 4 12 4 18 0" ${S}/>`],
    sad: ['Frown', `<circle cx="32" cy="32" r="27" ${S}/><circle cx="23" cy="26" r="3.5" ${F}/><circle cx="41" cy="26" r="3.5" ${F}/><path d="M21 46c3-5 7-7 11-7s8 2 11 7" ${S}/>`],
    // symbols
    heart: ['Heart', `<path d="M32 55S7 40 7 23c0-8 6-14 13-14 5 0 9 3 12 7 3-4 7-7 12-7 7 0 13 6 13 14 0 17-25 32-25 32z" ${F}/>`],
    heartline: ['Heart outline', `<path d="M32 53S9 39 9 23c0-7 5-12 11-12 5 0 9 3 12 7 3-4 7-7 12-7 6 0 11 5 11 12 0 16-23 30-23 30z" ${S}/>`],
    star: ['Star', `<path d="M32 5l8 17 19 2-14 13 4 19-17-10-17 10 4-19L5 24l19-2z" ${F}/>`],
    sparkle: ['Sparkles', `<path d="M24 8l4 14 14 4-14 4-4 14-4-14-14-4 14-4zM48 34l2 7 7 2-7 2-2 7-2-7-7-2 7-2z" ${F}/>`],
    check: ['Check mark', `<circle cx="32" cy="32" r="27" ${S}/><path d="M19 33l9 9 17-19" ${S} stroke-width="6"/>`],
    warn: ['Warning', `<path d="M32 6L3 56h58z" ${S} stroke-width="4.5"/><path d="M32 24v14" ${S} stroke-width="6"/><circle cx="32" cy="47" r="3.5" ${F}/>`],
    arrow: ['Arrow', `<path d="M8 32h42M36 16l16 16-16 16" ${S} stroke-width="6"/>`],
    up: ['This way up', `<path d="M20 30V10M10 20l10-10 10 10M44 30V10M34 20l10-10 10 10" ${S} stroke-width="5"/><path d="M8 40h48v16H8z" ${S}/>`],
    fragile: ['Fragile glass', `<path d="M20 6h24l-2 18c-1 6-5 10-10 10s-9-4-10-10zM32 34v18M22 56h20" ${S}/><path d="M28 12l3 6-4 4 5 5" ${S} stroke-width="3"/>`],
    // home
    house: ['House', `<path d="M8 30L32 9l24 21M14 25v29h36V25" ${S}/><path d="M27 54V39h10v15" ${S}/>`],
    key: ['Key', `<circle cx="20" cy="32" r="11" ${S}/><path d="M31 32h26M49 32v9M56 32v7" ${S}/>`],
    box: ['Box', `<path d="M8 20l24-12 24 12v26L32 58 8 46z" ${S}/><path d="M8 20l24 12 24-12M32 32v26" ${S}/>`],
    jar: ['Jar', `<rect x="18" y="6" width="28" height="9" rx="2" ${S}/><path d="M16 15h32v4c3 2 4 5 4 9v22c0 4-3 8-8 8H20c-5 0-8-4-8-8V28c0-4 1-7 4-9z" ${S}/><path d="M18 34h28" ${S}/>`],
    snow: ['Snowflake (freezer)', `<path d="M32 4v56M8 18l48 28M8 46l48-28M26 8l6 6 6-6M26 56l6-6 6 6" ${S}/>`],
    thermo: ['Thermometer', `<path d="M26 40V12a6 6 0 0 1 12 0v28a10 10 0 1 1-12 0z" ${S}/><circle cx="32" cy="48" r="5" ${F}/><path d="M32 46V22" ${S}/>`],
    plug: ['Plug / cable', `<path d="M22 6v12M42 6v12M14 18h36v10c0 10-8 16-18 16S14 38 14 28zM32 44v14" ${S}/>`],
    wifi: ['Wi-Fi', `<path d="M8 25c14-13 34-13 48 0M16 34c9-8 23-8 32 0M24 43c5-4 11-4 16 0" ${S} stroke-width="5"/><circle cx="32" cy="52" r="4" ${F}/>`],
    battery: ['Battery', `<rect x="6" y="18" width="46" height="28" rx="4" ${S}/><path d="M56 27v10" ${S} stroke-width="5"/><rect x="12" y="24" width="20" height="16" ${F}/>`],
    tools: ['Wrench', `<path d="M40 8a14 14 0 0 0-13 19L8 46a6 6 0 0 0 9 9l19-19a14 14 0 0 0 19-13l-8 8-8-2-2-8z" ${S}/>`],
    // food & kitchen
    utensils: ['Fork & knife', `<path d="M18 6v18c0 4 2 6 5 6v28M12 6v14M24 6v14M44 58V6c-6 4-9 12-9 22h9" ${S}/>`],
    cup: ['Coffee cup', `<path d="M10 22h36v16c0 10-8 18-18 18S10 48 10 38z" ${S}/><path d="M46 28h4a6 6 0 0 1 0 12h-4M20 8c-2 3 2 5 0 8M30 8c-2 3 2 5 0 8" ${S}/>`],
    apple: ['Apple', `<path d="M32 18c-4-3-14-4-18 4-5 9 0 25 7 31 4 3 7 2 11 0 4 2 7 3 11 0 7-6 12-22 7-31-4-8-14-7-18-4z" ${S}/><path d="M32 18c0-6 2-10 7-12" ${S}/>`],
    carrot: ['Carrot', `<path d="M14 50L42 22c4-4 10-2 10 4L22 54c-4 2-10 0-8-4z" ${S}/><path d="M44 20c0-6 4-10 10-12M48 24c4-2 8-2 12 0M24 44l4 4M32 36l4 4" ${S}/>`],
    cake: ['Birthday cake', `<path d="M10 34h44v22H10zM10 44c6 4 10-4 15 0s10 4 15 0 10-4 14 0" ${S}/><path d="M22 24v10M32 24v10M42 24v10" ${S}/><path d="M22 14c-2 3 2 5 0 8M32 14c-2 3 2 5 0 8M42 14c-2 3 2 5 0 8" ${S} stroke-width="3"/>`],
    // seasons & fun
    gift: ['Gift', `<rect x="8" y="26" width="48" height="30" rx="2" ${S}/><path d="M6 18h52v8H6zM32 18v38M32 18c-4-8-14-12-16-6s10 6 16 6c4-8 14-12 16-6s-10 6-16 6" ${S}/>`],
    tree: ['Christmas tree', `<path d="M32 4l10 14h-6l10 14h-6l10 14H14l10-14h-6l10-14h-6zM28 46h8v12h-8z" ${S}/>`],
    pumpkin: ['Pumpkin', `<path d="M32 18c-14-4-26 4-26 18s12 22 26 22 26-8 26-22-12-22-26-18z" ${S}/><path d="M32 18c-6 8-6 32 0 40M32 18c6 8 6 32 0 40M32 18c0-6 3-10 8-12" ${S}/>`],
    sun: ['Sun', `<circle cx="32" cy="32" r="12" ${S}/><path d="M32 4v8M32 52v8M4 32h8M52 32h8M12 12l6 6M46 46l6 6M12 52l6-6M46 18l6-6" ${S}/>`],
    moon: ['Moon', `<path d="M44 8a26 26 0 1 0 12 34A22 22 0 0 1 44 8z" ${S}/>`],
    flower: ['Flower', `<circle cx="32" cy="22" r="7" ${F}/><path d="M32 6c5 0 6 9 0 9s-5-9 0-9zM46 18c2 5-6 9-8 3s6-8 8-3zM40 34c-4 4-10-3-5-7s9 3 5 7zM24 34c-4-4 1-11 5-7s-1 11-5 7zM18 18c2-5 10-2 8 3s-10 2-8-3zM32 30v28M32 46c-6-6-14-6-16 0 6 4 12 4 16 0zM32 50c6-6 14-6 16 0-6 4-12 4-16 0z" ${S} stroke-width="3"/>`],
    leaf: ['Leaf', `<path d="M10 54C10 26 26 10 56 8c0 30-16 46-44 46zM10 54l26-26" ${S}/>`],
    paw: ['Paw print', `<ellipse cx="18" cy="26" rx="5" ry="7" ${F}/><ellipse cx="28" cy="16" rx="5" ry="7" ${F}/><ellipse cx="40" cy="16" rx="5" ry="7" ${F}/><ellipse cx="50" cy="26" rx="5" ry="7" ${F}/><path d="M34 32c-9 0-18 10-18 18 0 6 6 8 10 6 4-1 6-1 8-1s4 0 8 1c4 2 10 0 10-6 0-8-9-18-18-18z" ${F}/>`],
    music: ['Music note', `<path d="M24 46V12l28-6v34" ${S}/><circle cx="18" cy="46" r="7" ${F}/><circle cx="46" cy="40" r="7" ${F}/>`],
    envelope: ['Envelope', `<rect x="6" y="14" width="52" height="36" rx="3" ${S}/><path d="M6 16l26 20 26-20" ${S}/>`],
    phone: ['Phone', `<path d="M14 6h10l5 13-7 4c3 8 10 15 18 18l4-7 13 5v10c0 3-3 6-6 6C27 54 10 37 8 12c0-3 3-6 6-6z" ${S}/>`],
    baby: ['Baby bottle', `<path d="M26 4h12v8h-12zM22 12h20l2 6c3 2 4 4 4 8v24c0 5-4 9-9 9H25c-5 0-9-4-9-9V26c0-4 1-6 4-8z" ${S}/><path d="M24 32h16M24 42h16" ${S} stroke-width="3"/>`],
    car: ['Car', `<path d="M8 40v-8l6-14h36l6 14v8zM8 40v8h8v-8M48 40v8h8v-8" ${S}/><circle cx="18" cy="34" r="3" ${F}/><circle cx="46" cy="34" r="3" ${F}/>`],
    ball: ['Ball', `<circle cx="32" cy="32" r="26" ${S}/><path d="M8 26c16 6 32 6 48 0M8 40c16-6 32-6 48 0M32 6c-8 16-8 36 0 52" ${S} stroke-width="3"/>`],
    book: ['Book', `<path d="M8 12c10-3 18-1 24 4 6-5 14-7 24-4v40c-10-3-18-1-24 4-6-5-14-7-24-4z" ${S}/><path d="M32 16v40" ${S}/>`],
    pill: ['Pill', `<rect x="6" y="22" width="52" height="20" rx="10" transform="rotate(-35 32 32)" ${S}/><path d="M24 20l16 24" ${S}/>`],
    flag: ['Flag', `<path d="M14 58V6M14 8c12-6 22 6 36 0v26c-14 6-24-6-36 0" ${S}/>`]
  };
  window.CLIPART = Object.entries(art).map(([id, [name, body]]) => ({ id, name, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>` }));
})();
