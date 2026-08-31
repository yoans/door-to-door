const NEIGHBORHOOD = {
  id: "timberview-blooming-heights",
  name: "Timberview & Blooming Heights",
  center: [41.48672, -93.72021],
  zoom: 16,
};

const STORAGE_KEY = "wagon-popcorn-v1";
const STATUS_CODE = { unvisited: "0", answered: "1", bought: "2", no: "3", not_home: "4" };
const CODE_STATUS = Object.fromEntries(Object.entries(STATUS_CODE).map(([k, v]) => [v, k]));

const FILL = {
  unvisited: { color: "#f6efe4", weight: 1.2, fillColor: "#ffffff", fillOpacity: 0.08 },
  answered: { color: "#f4b942", weight: 2, fillColor: "#f4b942", fillOpacity: 0.5 },
  bought: { color: "#3dcc7a", weight: 2, fillColor: "#3dcc7a", fillOpacity: 0.5 },
  no: { color: "#e85d4c", weight: 2, fillColor: "#e85d4c", fillOpacity: 0.48 },
  not_home: { color: "#5eb3e8", weight: 2, fillColor: "#5eb3e8", fillOpacity: 0.45 },
};

const CLOUD_KEY = "wagon-popcorn-cloud";
const DATABASE_RULES = `{
  "rules": {
    "wagon": {
      "$room": {
        ".read": true,
        "houses": {
          ".write": true,
          "$pin": {
            ".validate": "!newData.exists() || (newData.hasChildren(['status', 'updatedAt']) && newData.child('status').isString() && newData.child('status').val().matches(/^(unvisited|answered|bought|no|not_home)$/) && newData.child('updatedAt').isNumber() && (!newData.hasChild('note') || (newData.child('note').isString() && newData.child('note').val().length <= 240)))"
          }
        }
      }
    }
  }
}`;

const state = loadState();
const layersById = new Map();
const parcelById = new Map();
let parcels = [];
let activeId = null;
let activeFilter = "all";
let map;
let locateMarker;
let locateWatch = null;
const houseLabels = [];
let cloud = { status: "off", room: NEIGHBORHOOD.id, housesRef: null, applying: false };
let writeTimes = [];

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.houses) {
        return { version: 2, neighborhood: NEIGHBORHOOD.id, houses: parsed.houses };
      }
    }
  } catch {
    /* start fresh */
  }
  return { version: 2, neighborhood: NEIGHBORHOOD.id, houses: {} };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function houseRecord(id) {
  return state.houses[id] || { status: "unvisited", note: "" };
}

function houseLabel(id) {
  const props = parcelById.get(id)?.properties || {};
  if (props.number && props.address) return props.address;
  if (props.street) return `Open lot · ${props.street}`;
  return props.address || "Open lot";
}

function setHouse(id, patch) {
  state.houses[id] = {
    ...houseRecord(id),
    ...patch,
    updatedAt: Date.now(),
  };
  if (state.houses[id].status === "unvisited" && !state.houses[id].note) {
    delete state.houses[id];
  }
  saveState();
  paintHouse(id);
  renderStats();
  syncHouseToCloud(id);
}

function paintHouse(id) {
  const layer = layersById.get(id);
  if (!layer) return;
  const status = houseRecord(id).status;
  layer.setStyle(styleFor(id, status));
}

function styleFor(id, status) {
  const base = { ...(FILL[status] || FILL.unvisited) };
  const visible = matchesFilter(status);
  if (!visible) {
    base.fillOpacity = 0.04;
    base.opacity = 0.2;
    base.weight = 0.6;
  }
  if (id === activeId) {
    base.weight = 3.2;
    base.color = "#ffffff";
  }
  return base;
}

function matchesFilter(status) {
  if (activeFilter === "all") return true;
  if (activeFilter === "unvisited") return status === "unvisited";
  if (activeFilter === "callback") return status === "answered" || status === "not_home";
  return status === activeFilter;
}

function lotFitsNumber(layer, number) {
  const bounds = layer.getBounds();
  const southWest = map.latLngToContainerPoint(bounds.getSouthWest());
  const northEast = map.latLngToContainerPoint(bounds.getNorthEast());
  const width = Math.abs(northEast.x - southWest.x);
  const height = Math.abs(northEast.y - southWest.y);
  return width >= 10 + number.length * 7 && height >= 18;
}

function updateHouseLabels() {
  if (!map) return;
  for (const item of houseLabels) {
    const status = houseRecord(item.id).status;
    const show = matchesFilter(status) && lotFitsNumber(item.layer, item.number);
    const el = item.marker.getElement();
    if (el) el.classList.toggle("is-hidden", !show);
  }
}

function renderStats() {
  const counts = { unvisited: 0, answered: 0, bought: 0, no: 0, not_home: 0 };
  for (const feature of parcels) {
    counts[houseRecord(feature.properties.id).status] += 1;
  }
  const total = parcels.length;
  const done = counts.bought + counts.no;
  document.getElementById("stats").innerHTML = `
    <div class="stat"><b>${done}</b> / ${total} done</div>
    <div class="stat bought"><svg class="ico"><use href="#i-bought"/></svg><b>${counts.bought}</b> bought</div>
    <div class="stat no"><svg class="ico"><use href="#i-no"/></svg><b>${counts.no}</b> no</div>
    <div class="stat answered"><svg class="ico"><use href="#i-answered"/></svg><b>${counts.answered}</b> later</div>
    <div class="stat not_home"><svg class="ico"><use href="#i-home"/></svg><b>${counts.not_home}</b> not home</div>
    <div class="stat unanswered"><svg class="ico"><use href="#i-open"/></svg><b>${counts.unvisited}</b> still out</div>
  `;
}

function openSheet(id) {
  activeId = id;
  paintHouse(id);
  const rec = houseRecord(id);
  document.getElementById("sheetTitle").textContent = houseLabel(id);
  document.getElementById("sheetSub").textContent = rec.note || "Tap a status for this house";
  document.getElementById("noteInput").value = rec.note || "";
  document.querySelectorAll(".status-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.status === rec.status);
  });
  document.getElementById("sheet").classList.remove("hidden");
  document.getElementById("sheet").setAttribute("aria-hidden", "false");
  document.getElementById("sheetBackdrop").classList.remove("hidden");
}

function closeSheet() {
  const prev = activeId;
  activeId = null;
  if (prev) paintHouse(prev);
  document.getElementById("sheet").classList.add("hidden");
  document.getElementById("sheet").setAttribute("aria-hidden", "true");
  document.getElementById("sheetBackdrop").classList.add("hidden");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toggleDrawer(id, open) {
  const el = document.getElementById(id);
  el.classList.toggle("hidden", !open);
  el.setAttribute("aria-hidden", open ? "false" : "true");
  document.getElementById("sheetBackdrop").classList.toggle("hidden", !open && !activeId);
}

function loadCloudSettings() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_KEY) || "null");
  } catch {
    return null;
  }
}

function saveCloudSettings(settings) {
  if (settings) localStorage.setItem(CLOUD_KEY, JSON.stringify(settings));
  else localStorage.removeItem(CLOUD_KEY);
}

function parseFirebaseConfig(text) {
  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    /* firebase console paste is a JS object, not JSON */
  }
  const grab = (key) => {
    const match = raw.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
    return match ? match[1] : "";
  };
  const config = {
    apiKey: grab("apiKey"),
    authDomain: grab("authDomain"),
    databaseURL: grab("databaseURL"),
    projectId: grab("projectId"),
    storageBucket: grab("storageBucket"),
    messagingSenderId: grab("messagingSenderId"),
    appId: grab("appId"),
  };
  if (!config.apiKey || !config.projectId || !config.databaseURL) {
    throw new Error("Need apiKey, projectId, and databaseURL from firebaseConfig.");
  }
  return config;
}

function setCloudUi(status, note) {
  cloud.status = status;
  const label =
    status === "live" ? "Cloud: live" : status === "error" ? "Cloud: paused" : "Cloud: off";
  const stateEl = document.getElementById("cloudState");
  const noteEl = document.getElementById("cloudNote");
  const btn = document.getElementById("cloudBtn");
  if (stateEl) stateEl.textContent = label;
  if (noteEl && note !== undefined) noteEl.textContent = note;
  if (btn) btn.classList.toggle("live", status === "live");
}

function withinWriteBudget() {
  const now = Date.now();
  writeTimes = writeTimes.filter((time) => now - time < 60000);
  if (writeTimes.length >= 40) return false;
  writeTimes.push(now);
  return true;
}

function syncHouseToCloud(id) {
  if (cloud.status !== "live" || !cloud.housesRef || cloud.applying) return;
  if (!withinWriteBudget()) {
    setCloudUi("error", "Write cap reached for this minute. Sync will try again as you keep tapping.");
    return;
  }
  const rec = state.houses[id];
  const ref = cloud.housesRef.child(id);
  const write = rec
    ? ref.set({
        status: rec.status,
        note: (rec.note || "").slice(0, 240),
        updatedAt: rec.updatedAt || Date.now(),
      })
    : ref.remove();
  write
    .then(() => {
      if (cloud.housesRef && cloud.status === "error") {
        setCloudUi("live", `Sharing room “${cloud.room}” on the free Spark plan. If a cap is hit, sync stops.`);
      }
    })
    .catch((err) => {
      setCloudUi("error", quotaMessage(err));
    });
}

function quotaMessage(err) {
  const code = String(err && (err.code || err.message) || "");
  if (/quota|limit|exceeded/i.test(code)) {
    return "Firebase free cap hit. Sync paused so you are not billed. Local map still works.";
  }
  return err.message || "Cloud write failed. Local map still works.";
}

function applyRemoteHouses(remote, prune) {
  cloud.applying = true;
  const incoming = remote || {};
  let changed = false;
  for (const [id, rec] of Object.entries(incoming)) {
    if (!rec || !rec.status) continue;
    const current = state.houses[id];
    if (current && (current.updatedAt || 0) > (rec.updatedAt || 0)) continue;
    state.houses[id] = {
      status: rec.status,
      note: rec.note || "",
      updatedAt: rec.updatedAt || 0,
    };
    changed = true;
  }
  if (prune) {
    for (const id of Object.keys(state.houses)) {
      if (incoming[id]) continue;
      if ((state.houses[id].updatedAt || 0) > Date.now() - 2000) continue;
      delete state.houses[id];
      changed = true;
    }
  }
  if (changed) {
    saveState();
    for (const id of layersById.keys()) paintHouse(id);
    renderStats();
    updateHouseLabels();
  }
  cloud.applying = false;
}

function pushLocalNewer(remote) {
  const incoming = remote || {};
  const updates = {};
  for (const [id, rec] of Object.entries(state.houses)) {
    const other = incoming[id];
    if (!other || (rec.updatedAt || 0) > (other.updatedAt || 0)) {
      updates[id] = {
        status: rec.status,
        note: (rec.note || "").slice(0, 240),
        updatedAt: rec.updatedAt || Date.now(),
      };
    }
  }
  if (Object.keys(updates).length && cloud.housesRef) {
    cloud.housesRef.update(updates).catch((err) => setCloudUi("error", quotaMessage(err)));
  }
}

async function connectCloud(config, room) {
  if (typeof firebase === "undefined") {
    throw new Error("Firebase failed to load. Check the network and try again.");
  }
  if (firebase.apps.length) {
    await firebase.app().delete();
  }
  firebase.initializeApp(config);
  const safeRoom = (room || NEIGHBORHOOD.id).replace(/[^\w-]/g, "").slice(0, 40) || NEIGHBORHOOD.id;
  cloud.room = safeRoom;
  cloud.housesRef = firebase.database().ref(`wagon/${safeRoom}/houses`);
  const snap = await cloud.housesRef.get();
  const remote = snap.val() || {};
  applyRemoteHouses(remote, false);
  cloud.status = "live";
  pushLocalNewer(remote);
  cloud.housesRef.off();
  cloud.housesRef.on(
    "value",
    (next) => applyRemoteHouses(next.val() || {}, true),
    (err) => setCloudUi("error", quotaMessage(err))
  );
  saveCloudSettings({ config, room: safeRoom });
  setCloudUi("live", `Sharing room “${safeRoom}” on the free Spark plan. If a cap is hit, sync stops.`);
}

async function disconnectCloud() {
  if (cloud.housesRef) cloud.housesRef.off();
  cloud.housesRef = null;
  if (typeof firebase !== "undefined" && firebase.apps.length) {
    await firebase.app().delete();
  }
  setCloudUi("off", "This phone is local-only again.");
}

async function connectFromForm() {
  const note = document.getElementById("cloudNote");
  try {
    const config = parseFirebaseConfig(document.getElementById("cloudConfig").value);
    const room = document.getElementById("cloudRoom").value.trim() || NEIGHBORHOOD.id;
    note.textContent = "Connecting…";
    await connectCloud(config, room);
  } catch (err) {
    setCloudUi("error", err.message || String(err));
  }
}

function setupMap(data) {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
  }).setView(NEIGHBORHOOD.center, NEIGHBORHOOD.zoom);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri" }
  ).addTo(map);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19 }
  ).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.createPane("houseLabels");
  map.getPane("houseLabels").style.zIndex = 450;
  map.getPane("houseLabels").style.pointerEvents = "none";

  const layer = L.geoJSON(data, {
    style: (feature) => styleFor(feature.properties.id, houseRecord(feature.properties.id).status),
    onEachFeature: (feature, lyr) => {
      const id = feature.properties.id;
      layersById.set(id, lyr);
      const label = feature.properties.number;
      if (label) {
        const marker = L.marker(lyr.getBounds().getCenter(), {
          pane: "houseLabels",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "house-num is-hidden",
            html: `<span>${escapeHtml(label)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        }).addTo(map);
        houseLabels.push({ id, marker, layer: lyr, number: label });
      }
      lyr.on("click", () => openSheet(id));
    },
  }).addTo(map);

  const bounds = layer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [80, 80] });
  map.on("zoomend moveend", updateHouseLabels);
  map.whenReady(updateHouseLabels);
  requestAnimationFrame(updateHouseLabels);
}

function setupUi() {
  document.getElementById("sheetClose").addEventListener("click", closeSheet);
  document.getElementById("sheetBackdrop").addEventListener("click", () => {
    closeSheet();
    toggleDrawer("menuPanel", false);
  });

  document.querySelectorAll(".status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!activeId) return;
      const status = btn.dataset.status;
      setHouse(activeId, { status, note: document.getElementById("noteInput").value });
      document.querySelectorAll(".status-btn").forEach((el) => {
        el.classList.toggle("selected", el.dataset.status === status);
      });
    });
  });

  document.getElementById("noteInput").addEventListener("change", (event) => {
    if (!activeId) return;
    setHouse(activeId, { note: event.target.value, status: houseRecord(activeId).status });
    document.getElementById("sheetSub").textContent = event.target.value || "Tap a status for this house";
  });

  document.getElementById("menuBtn").addEventListener("click", () => {
    closeSheet();
    toggleDrawer("menuPanel", true);
  });
  document.getElementById("menuClose").addEventListener("click", () => toggleDrawer("menuPanel", false));

  document.getElementById("filters").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("active", chip === btn);
    });
    for (const id of layersById.keys()) paintHouse(id);
    updateHouseLabels();
  });

  document.getElementById("locateBtn").addEventListener("click", toggleLocate);
  document.getElementById("cloudBtn").addEventListener("click", () => {
    closeSheet();
    toggleDrawer("menuPanel", true);
  });
  document.getElementById("shareBtn").addEventListener("click", copyShareLink);
  document.getElementById("exportBtn").addEventListener("click", exportProgress);
  document.getElementById("resetBtn").addEventListener("click", resetHouses);
  document.getElementById("copyRulesBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(DATABASE_RULES);
      document.getElementById("copyRulesBtn").textContent = "Rules copied";
      setTimeout(() => {
        document.getElementById("copyRulesBtn").textContent = "Copy database rules";
      }, 1600);
    } catch {
      prompt("Copy these rules into Firebase → Realtime Database → Rules", DATABASE_RULES);
    }
  });
  document.getElementById("cloudConnectBtn").addEventListener("click", connectFromForm);
  document.getElementById("cloudDisconnectBtn").addEventListener("click", async () => {
    saveCloudSettings(null);
    await disconnectCloud();
  });
  const saved = loadCloudSettings();
  if (saved?.config) {
    document.getElementById("cloudConfig").value = JSON.stringify(saved.config, null, 2);
    document.getElementById("cloudRoom").value = saved.room || NEIGHBORHOOD.id;
  }
}

function toggleLocate() {
  const btn = document.getElementById("locateBtn");
  if (locateWatch) {
    navigator.geolocation.clearWatch(locateWatch);
    locateWatch = null;
    if (locateMarker) {
      map.removeLayer(locateMarker);
      locateMarker = null;
    }
    btn.classList.remove("active");
    return;
  }
  if (!navigator.geolocation) {
    alert("Location is not available in this browser.");
    return;
  }
  btn.classList.add("active");
  locateWatch = navigator.geolocation.watchPosition(
    (pos) => {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      if (!locateMarker) {
        locateMarker = L.circleMarker(latlng, {
          radius: 8,
          color: "#ffffff",
          weight: 2,
          fillColor: "#4da3ff",
          fillOpacity: 1,
        }).addTo(map);
        map.setView(latlng, Math.max(map.getZoom(), 18));
      } else {
        locateMarker.setLatLng(latlng);
      }
    },
    () => {
      alert("Could not get your location. Check browser permissions.");
      toggleLocate();
    },
    { enableHighAccuracy: true, maximumAge: 4000 }
  );
}

function sharePayload() {
  const houses = {};
  for (const [id, rec] of Object.entries(state.houses)) {
    if (!rec || (rec.status === "unvisited" && !rec.note)) continue;
    houses[id] = {
      s: STATUS_CODE[rec.status] || "0",
      n: rec.note || "",
      t: rec.updatedAt || 0,
    };
  }
  return { v: 2, houses };
}

function encodeShare(payload) {
  const json = JSON.stringify(payload);
  return btoa(unescape(encodeURIComponent(json))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeShare(token) {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/");
  const json = decodeURIComponent(escape(atob(padded)));
  return JSON.parse(json);
}

function mergeSharedHouses(incoming) {
  if (!incoming || !incoming.houses) return 0;
  let applied = 0;
  for (const [id, rec] of Object.entries(incoming.houses)) {
    const status = CODE_STATUS[rec.s] || rec.status || "unvisited";
    const note = rec.n || rec.note || "";
    const updatedAt = rec.t || rec.updatedAt || 0;
    const current = state.houses[id];
    if (current && (current.updatedAt || 0) > updatedAt) continue;
    state.houses[id] = { status, note, updatedAt };
    applied += 1;
  }
  saveState();
  return applied;
}

function applyShareFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("s") || hash.get("s");
  if (!token) return;
  try {
    const incoming = decodeShare(token);
    mergeSharedHouses(incoming);
  } catch (err) {
    console.warn("Could not read share link", err);
  }
}

async function copyShareLink() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("s", encodeShare(sharePayload()));
  const link = url.toString();
  try {
    await navigator.clipboard.writeText(link);
    document.getElementById("shareBtn").textContent = "Link copied";
    setTimeout(() => {
      document.getElementById("shareBtn").textContent = "Copy share link";
    }, 1600);
  } catch {
    prompt("Copy this link", link);
  }
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wagon-popcorn-${NEIGHBORHOOD.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function resetHouses() {
  if (!confirm("Clear every house status and note on this phone?")) return;
  const clearCloud =
    cloud.status === "live" &&
    confirm("Also clear the shared cloud route for every phone?");
  state.houses = {};
  saveState();
  for (const id of layersById.keys()) paintHouse(id);
  renderStats();
  updateHouseLabels();
  closeSheet();
  toggleDrawer("menuPanel", false);
  if (clearCloud && cloud.housesRef) {
    cloud.housesRef.remove().catch((err) => setCloudUi("error", quotaMessage(err)));
  }
}

async function start() {
  applyShareFromUrl();
  setupUi();
  const response = await fetch("data/parcels.geojson");
  const data = await response.json();
  parcels = data.features;
  for (const feature of parcels) parcelById.set(feature.properties.id, feature);
  setupMap(data);
  renderStats();
  const saved = loadCloudSettings();
  if (saved?.config) {
    connectCloud(saved.config, saved.room).catch((err) => {
      setCloudUi("error", err.message || String(err));
    });
  }
}

start().catch((err) => {
  document.getElementById("stats").textContent = "Could not load neighborhood lots.";
  console.error(err);
});
