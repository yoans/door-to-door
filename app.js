const NEIGHBORHOOD = {
  id: "timberview-blooming-heights",
  name: "Timberview & Blooming Heights",
  center: [41.48672, -93.72021],
  zoom: 16,
};

const STATUSES = ["unvisited", "answered", "bought", "no", "not_home"];
const STORAGE_KEY = "wagon-popcorn-v1";

const DEFAULT_STOCK = [
  { id: "caramel", name: "Caramel", qty: 0 },
  { id: "cheddar", name: "Cheddar", qty: 0 },
  { id: "kettle", name: "Kettle", qty: 0 },
  { id: "butter", name: "Butter", qty: 0 },
];

const FILL = {
  unvisited: { color: "#f6efe4", weight: 1.2, fillColor: "#ffffff", fillOpacity: 0.08 },
  answered: { color: "#f4b942", weight: 2, fillColor: "#f4b942", fillOpacity: 0.5 },
  bought: { color: "#3dcc7a", weight: 2, fillColor: "#3dcc7a", fillOpacity: 0.5 },
  no: { color: "#e85d4c", weight: 2, fillColor: "#e85d4c", fillOpacity: 0.48 },
  not_home: { color: "#5eb3e8", weight: 2, fillColor: "#5eb3e8", fillOpacity: 0.45 },
};

const state = loadState();
const layersById = new Map();
let parcels = [];
let activeId = null;
let activeFilter = "all";
let map;
let locateMarker;
let locateWatch = null;
let saleDraft = {};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.houses && parsed.stock) return parsed;
    }
  } catch {
    /* start fresh */
  }
  return {
    version: 1,
    neighborhood: NEIGHBORHOOD.id,
    houses: {},
    stock: DEFAULT_STOCK.map((item) => ({ ...item })),
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function houseRecord(id) {
  return state.houses[id] || { status: "unvisited", note: "" };
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
}

function paintHouse(id) {
  const layer = layersById.get(id);
  if (!layer) return;
  const status = houseRecord(id).status;
  layer.setStyle(styleFor(id, status));
}

function styleFor(id, status) {
  const base = { ...FILL[status] || FILL.unvisited };
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

function renderStats() {
  const counts = {
    unvisited: 0,
    answered: 0,
    bought: 0,
    no: 0,
    not_home: 0,
  };
  for (const feature of parcels) {
    const status = houseRecord(feature.properties.id).status;
    counts[status] += 1;
  }
  const total = parcels.length;
  const done = counts.bought + counts.no;
  document.getElementById("stats").innerHTML = `
    <div class="stat"><b>${done}</b> / ${total} done</div>
    <div class="stat"><b>${counts.bought}</b> bought</div>
    <div class="stat"><b>${counts.no}</b> no</div>
    <div class="stat"><b>${counts.answered}</b> answered</div>
    <div class="stat"><b>${counts.not_home}</b> not home</div>
    <div class="stat"><b>${counts.unvisited}</b> still out</div>
  `;
}

function openSheet(id) {
  activeId = id;
  paintHouse(id);
  const rec = houseRecord(id);
  saleDraft = {};
  document.getElementById("sheetTitle").textContent = `Lot ${id}`;
  document.getElementById("sheetSub").textContent = rec.note
    ? rec.note
    : "Tap a status for this house";
  document.getElementById("noteInput").value = rec.note || "";
  document.querySelectorAll(".status-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.status === rec.status);
  });
  renderSaleBox(rec.status);
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

function renderSaleBox(status) {
  const box = document.getElementById("saleBox");
  const list = document.getElementById("saleItems");
  if (status !== "bought") {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  list.innerHTML = state.stock
    .map((item) => {
      const qty = saleDraft[item.id] || 0;
      return `<div class="sale-row">
        <span>${escapeHtml(item.name)} <small>(${item.qty} left)</small></span>
        <button class="step" data-sale-dec="${item.id}" type="button">−</button>
        <span class="qty">${qty}</span>
        <button class="step" data-sale-inc="${item.id}" type="button">+</button>
      </div>`;
    })
    .join("");
}

function takeFromWagon(itemId, delta) {
  const item = state.stock.find((row) => row.id === itemId);
  if (!item) return;
  if (delta > 0) {
    if (item.qty < 1) return;
    item.qty -= 1;
    saleDraft[itemId] = (saleDraft[itemId] || 0) + 1;
  } else {
    if ((saleDraft[itemId] || 0) < 1) return;
    item.qty += 1;
    saleDraft[itemId] -= 1;
  }
  saveState();
  renderSaleBox("bought");
  renderStock();
}

function restoreSaleDraft() {
  for (const [itemId, qty] of Object.entries(saleDraft)) {
    const item = state.stock.find((row) => row.id === itemId);
    if (item) item.qty += qty;
  }
  saleDraft = {};
  saveState();
  renderStock();
}

function renderStock() {
  const list = document.getElementById("stockList");
  if (!state.stock.length) {
    list.innerHTML = `<p class="sheet-head"><span>Nothing loaded yet. Add what you brought.</span></p>`;
    return;
  }
  list.innerHTML = state.stock
    .map(
      (item) => `<div class="stock-row" data-item="${item.id}">
        <input type="text" value="${escapeHtml(item.name)}" data-rename="${item.id}" />
        <button class="step" data-dec="${item.id}" type="button">−</button>
        <span class="qty">${item.qty}</span>
        <button class="step" data-inc="${item.id}" type="button">+</button>
        <button class="step" data-remove="${item.id}" type="button" aria-label="Remove">✕</button>
      </div>`
    )
    .join("");
}

function changeStock(id, delta) {
  const item = state.stock.find((row) => row.id === id);
  if (!item) return;
  item.qty = Math.max(0, item.qty + delta);
  saveState();
  renderStock();
}

function toggleDrawer(id, open) {
  const el = document.getElementById(id);
  el.classList.toggle("hidden", !open);
  el.setAttribute("aria-hidden", open ? "false" : "true");
  document.getElementById("sheetBackdrop").classList.toggle("hidden", !open && !activeId);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setupMap(data) {
  map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
  }).setView(NEIGHBORHOOD.center, NEIGHBORHOOD.zoom);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles © Esri",
    }
  ).addTo(map);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19 }
  ).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  const layer = L.geoJSON(data, {
    style: (feature) => styleFor(feature.properties.id, houseRecord(feature.properties.id).status),
    onEachFeature: (feature, lyr) => {
      const id = feature.properties.id;
      layersById.set(id, lyr);
      lyr.on("click", () => openSheet(id));
    },
  }).addTo(map);

  const bounds = layer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [80, 80] });
}

function setupUi() {
  document.getElementById("sheetClose").addEventListener("click", closeSheet);
  document.getElementById("sheetBackdrop").addEventListener("click", () => {
    closeSheet();
    toggleDrawer("stockPanel", false);
    toggleDrawer("menuPanel", false);
  });

  document.querySelectorAll(".status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!activeId) return;
      const status = btn.dataset.status;
      const prev = houseRecord(activeId).status;
      if (prev === "bought" && status !== "bought") {
        restoreSaleDraft();
      }
      setHouse(activeId, { status, note: document.getElementById("noteInput").value });
      document.querySelectorAll(".status-btn").forEach((el) => {
        el.classList.toggle("selected", el.dataset.status === status);
      });
      renderSaleBox(status);
    });
  });

  document.getElementById("noteInput").addEventListener("change", (event) => {
    if (!activeId) return;
    setHouse(activeId, { note: event.target.value, status: houseRecord(activeId).status });
    document.getElementById("sheetSub").textContent = event.target.value || "Tap a status for this house";
  });

  document.getElementById("saleItems").addEventListener("click", (event) => {
    const inc = event.target.dataset.saleInc;
    const dec = event.target.dataset.saleDec;
    const id = inc || dec;
    if (!id) return;
    takeFromWagon(id, inc ? 1 : -1);
  });

  document.getElementById("stockBtn").addEventListener("click", () => {
    closeSheet();
    toggleDrawer("menuPanel", false);
    renderStock();
    toggleDrawer("stockPanel", true);
  });
  document.getElementById("stockClose").addEventListener("click", () => toggleDrawer("stockPanel", false));

  document.getElementById("menuBtn").addEventListener("click", () => {
    closeSheet();
    toggleDrawer("stockPanel", false);
    toggleDrawer("menuPanel", true);
  });
  document.getElementById("menuClose").addEventListener("click", () => toggleDrawer("menuPanel", false));

  document.getElementById("stockList").addEventListener("click", (event) => {
    if (event.target.dataset.inc) changeStock(event.target.dataset.inc, 1);
    if (event.target.dataset.dec) changeStock(event.target.dataset.dec, -1);
    if (event.target.dataset.remove) {
      state.stock = state.stock.filter((item) => item.id !== event.target.dataset.remove);
      saveState();
      renderStock();
    }
    if (event.target.classList.contains("qty")) {
      const row = event.target.closest("[data-item]");
      const item = state.stock.find((rowItem) => rowItem.id === row?.dataset.item);
      if (!item) return;
      const typed = prompt(`Set ${item.name} quantity`, String(item.qty));
      if (typed === null) return;
      const next = Number(typed);
      if (Number.isFinite(next) && next >= 0) {
        item.qty = Math.floor(next);
        saveState();
        renderStock();
      }
    }
  });

  document.getElementById("stockList").addEventListener("change", (event) => {
    const id = event.target.dataset.rename;
    if (!id) return;
    const item = state.stock.find((row) => row.id === id);
    if (item) {
      item.name = event.target.value.trim() || item.name;
      saveState();
    }
  });

  document.getElementById("addItemForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.getElementById("newItemName").value.trim();
    const qty = Math.max(0, Number(document.getElementById("newItemQty").value) || 0);
    if (!name) return;
    state.stock.push({ id: crypto.randomUUID(), name, qty });
    document.getElementById("newItemName").value = "";
    document.getElementById("newItemQty").value = "0";
    saveState();
    renderStock();
  });

  document.getElementById("filters").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-filter]");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("active", chip === btn);
    });
    for (const id of layersById.keys()) paintHouse(id);
  });

  document.getElementById("locateBtn").addEventListener("click", toggleLocate);
  document.getElementById("exportBtn").addEventListener("click", exportProgress);
  document.getElementById("resetBtn").addEventListener("click", resetHouses);
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
  state.houses = {};
  saveState();
  for (const id of layersById.keys()) paintHouse(id);
  renderStats();
  closeSheet();
  toggleDrawer("menuPanel", false);
}

async function start() {
  setupUi();
  const response = await fetch("data/parcels.geojson");
  const data = await response.json();
  parcels = data.features;
  setupMap(data);
  renderStats();
  renderStock();
}

start().catch((err) => {
  document.getElementById("stats").textContent = "Could not load neighborhood lots.";
  console.error(err);
});
