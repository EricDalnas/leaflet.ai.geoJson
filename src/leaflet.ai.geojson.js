/**
 * @file leaflet.ai.geojson.js
 * @module Leaflet.AI.GeoJSON
 * @description A Leaflet control that lets users query an LLM for geographic
 * data. Features are added to the map as toggleable layers; navigation
 * queries pan/zoom the map without drawing anything.
 *
 * Requires Leaflet 1.7+.
 *

 * @example <caption>Via proxy (the plugin never holds API keys directly)</caption>
 * // Start a local proxy first:  npm run proxy   (see examples/proxy-node)
 * L.control.aiGeojson({
 *   proxyUrl:     '/llm',
 *   modelListUrl: '/models',
 *   model:        'gemini-2.5-flash'
 * }).addTo(map);
 *
 * @example <caption>What users can type</caption>
 * // "Show the countries of West Africa"   → draws polygon features
 * // "Mark the 10 tallest mountains"       → places point markers
 * // "Zoom to New Zealand"                 → pans the map, no layer drawn
 * // "Trace the Amazon River"              → draws a LineString
 */
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define(['leaflet'], factory);
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('leaflet'));
  } else {
    factory(window.L);
  }
})(function (L) {
  'use strict';

  /**
   * Builds the system prompt sent before every user message.
   * Teaches the model two response modes: GeoJSON (for drawing) and
   * ZoomTo (for navigation).
   * @param {number} maxPolygonCoordinates - Maximum coordinate pairs per
   *   polygon ring, injected into the prompt to prevent truncation.
   * @returns {string} Formatted system prompt string.
   */
  function buildSystemPrompt(maxPolygonCoordinates) {
    var maxCoords = maxPolygonCoordinates || 50;
    return [
      'You are a geographic data assistant. When the user asks a question:',
      '',
      '1. If the user wants to DRAW or SHOW data (countries, cities, routes, landmarks, etc.), respond with valid GeoJSON (RFC 7946) wrapped in a ```geojson code fence.',
      '2. If the user wants to NAVIGATE or ZOOM TO a place without drawing data (e.g. "zoom to Florida", "go to Tokyo"), respond ONLY with a ZoomTo object in a ```json code fence: {"type":"ZoomTo","name":"...","bbox":[minLon,minLat,maxLon,maxLat]}',
      '3. Prefer real-world coordinates. Each GeoJSON Feature should have a "properties" object with at least a "name" field.',
      '4. If you absolutely cannot help, explain why in plain text with NO code fence.',
      '5. Return data only — no lengthy explanation alongside the code fence.',
      '6. Coordinates must use [longitude, latitude] order per the GeoJSON spec.',
      '7. Use simplified/low-resolution geometry. Polygon rings must have at most ' + maxCoords + ' coordinate pairs. Do NOT generate dense coordinate arrays.'
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Attempts to extract a GeoJSON object (or ZoomTo directive) from a raw
   * LLM response string. Tries fenced code blocks first, then falls back to
   * scanning the text for bare JSON.
   * @param {string} text - Raw text response from the LLM.
   * @returns {Object|null} Parsed JSON object, or null if nothing valid found.
   */
  function extractGeoJSON(text) {
    // 1. Try fenced code blocks (```geojson ... ``` or ```json ... ```)
    var fenceRe = /```(?:geo)?json\s*\n([\s\S]*?)```/i;
    var match = text.match(fenceRe);
    if (match) {
      try { return JSON.parse(match[1]); } catch (_) { /* fall through */ }
    }

    // 2. Try any fenced code block
    var anyFence = /```\s*\n([\s\S]*?)```/;
    match = text.match(anyFence);
    if (match) {
      try { return JSON.parse(match[1]); } catch (_) { /* fall through */ }
    }

    // 3. Try to find a raw JSON object/array in the text
    var jsonRe = /(\{[\s\S]*\}|\[[\s\S]*\])/;
    match = text.match(jsonRe);
    if (match) {
      try { return JSON.parse(match[1]); } catch (_) { /* fall through */ }
    }

    return null;
  }

  /**
   * Returns true if the given object has a GeoJSON `type` property.
   * Does not perform deep schema validation.
   * @param {*} obj - Value to test.
   * @returns {boolean}
   */
  function isGeoJSON(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var validTypes = [
      'Point', 'MultiPoint', 'LineString', 'MultiLineString',
      'Polygon', 'MultiPolygon', 'GeometryCollection',
      'Feature', 'FeatureCollection'
    ];
    return validTypes.indexOf(obj.type) !== -1;
  }

  /**
   * Derives a short human-readable title for a layer from the GeoJSON
   * content or, as a fallback, from the original query string.
   * @param {string} query  - The user's original query text.
   * @param {Object} geojson - The parsed GeoJSON object.
   * @returns {string} A title of at most ~40 characters.
   */
  function deriveTitle(query, geojson) {
    if (geojson.type === 'FeatureCollection' && geojson.features && geojson.features.length) {
      var first = geojson.features[0];
      if (first.properties && first.properties.name) {
        var suffix = geojson.features.length > 1
          ? ' (+' + (geojson.features.length - 1) + ' more)'
          : '';
        return first.properties.name + suffix;
      }
    }
    if (geojson.type === 'Feature' && geojson.properties && geojson.properties.name) {
      return geojson.properties.name;
    }
    // Fall back to truncated query
    return query.length > 40 ? query.substring(0, 37) + '...' : query;
  }

  /** @returns {string} A unique DOM-safe ID string. */
  var _idCounter = 0;
  function uid() { return 'aigeojson-' + (++_idCounter); }

  /**
   * Heuristically detects whether a model response was cut off before the
   * GeoJSON was complete. Used to give a more actionable error message.
   * @param {string} text - Raw LLM response.
   * @returns {boolean} True if the response appears truncated.
   */
  function isTruncated(text) {
    if (!text) return false;
    // If a complete closing fence exists, it's not truncated (just bad JSON inside)
    if (/```(?:geo)?json\s*\n[\s\S]*?```/i.test(text)) return false;
    // Has an opening fence but no closing fence
    if (/```(?:geo)?json/i.test(text)) return true;
    // No fence but looks like GeoJSON was being written: check bracket balance
    var jsonStart = text.search(/{[\s\S]*"type"/);
    if (jsonStart === -1) return false;
    var content = text.slice(jsonStart);
    var opens = (content.match(/[\[{]/g) || []).length;
    var closes = (content.match(/[\]}]/g) || []).length;
    return opens > closes + 2; // significant imbalance = truncated
  }

  /**
   * Annotates a 429 error with retry timing parsed from the response body
   * and headers. Mutates `err` in place.
   *
   * Sets one of:
   * - `err.retryAfterMs` {number} — milliseconds to wait before retrying
   * - `err.dailyQuotaExhausted` {boolean} — daily limit hit, retry tomorrow
   *
   * Works for both the native Gemini error format and OpenRouter/OpenAI.
   *
   * @param {Error}       err              - Error object to annotate.
   * @param {string}      responseText     - Raw response body text.
   * @param {string|null} retryAfterHeader - Value of Retry-After header, if any.
   */
  function parse429Error(err, responseText, retryAfterHeader) {
    try {
      var parsed = JSON.parse(responseText);
      // Google wraps in an array at some endpoints; normalise
      var body = Array.isArray(parsed) ? parsed[0] : parsed;
      var details = (body.error && body.error.details) || [];
      for (var i = 0; i < details.length; i++) {
        var d = details[i];
        // Scan QuotaFailure violations for PerDay vs PerMinute scope
        if (d.violations) {
          for (var j = 0; j < d.violations.length; j++) {
            var v = d.violations[j];
            var qid = (v.quotaId || '').toLowerCase();
            if (/perday/i.test(qid)) {
              err.dailyQuotaExhausted = true;
              err.retryAfterMs = null;
              return; // daily — no point reading further
            }
            if (/perminute/i.test(qid) && !err.retryAfterMs) {
              err.retryAfterMs = 62000; // wait one full minute + buffer
            }
          }
        }
        // retryDelay field (seconds string, e.g. "30s" or "30")
        if (d.retryDelay && !err.retryAfterMs && !err.dailyQuotaExhausted) {
          var raw = String(d.retryDelay).replace(/[^0-9.]/g, '');
          var secs = parseFloat(raw);
          if (!isNaN(secs)) err.retryAfterMs = Math.ceil(secs * 1000) + 500;
        }
      }
    } catch (_) {}
    // Retry-After header (OpenAI / OpenRouter)
    if (retryAfterHeader && !err.retryAfterMs && !err.dailyQuotaExhausted) {
      var raSecs = parseFloat(retryAfterHeader);
      if (!isNaN(raSecs)) err.retryAfterMs = Math.ceil(raSecs * 1000) + 500;
    }
    // Still nothing — assume per-minute (safer than assuming daily exhaustion)
    if (!err.retryAfterMs && !err.dailyQuotaExhausted) {
      err.retryAfterMs = 62000;
    }
  }

  /**
   * HTML-escapes a string for safe insertion via `innerHTML`.
   * @param {string} str - Plain text to escape.
   * @returns {string} HTML-escaped string.
   */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // L.Control.AiGeojson
  // ---------------------------------------------------------------------------

  /**
   * @typedef  {Object} AiGeojsonOptions
   * @property {string}  [position='topright']       - Leaflet control position on the map.
   * @property {string}  [model='gemini-2.5-flash']  - Model identifier.
   * @property {string|null} [systemPrompt=null]     - Custom system prompt; auto-generated if null.
   * @property {number}  [maxTokens=8192]            - Maximum output tokens per request.
   * @property {number}  [temperature=0.2]           - Model temperature (0–1).
   * @property {number}  [maxPolygonCoordinates=500]  - Max coordinate pairs per polygon ring.
   * @property {Object}  [style]                     - Base Leaflet path style for all vector features.
   * @property {Object|null} [polygonStyle=null]     - Style overrides for polygons (merged on top of style).
   * @property {Object|null} [lineStyle=null]        - Style overrides for lines (merged on top of style).
   * @property {'marker'|'circle'} [pointStyle='marker'] - How to render Point features.
   * @property {number}  [pointRadius=6]             - Circle marker radius in pixels.
   * @property {Object}  [markerOptions={}]          - Options passed to `L.marker()` for point features.
   * @property {boolean} [popups=true]               - Bind a property popup to each feature.
   * @property {boolean} [modelPicker=false]         - Show a model-selector dropdown in the panel. Requires `modelListUrl`.
   * @property {string|null} [modelListUrl=null]      - URL returning a model list `[{id, name}]`.
   *   The proxy server must expose a GET endpoint in this format.
   *   See `examples/proxy-node` for a working implementation.
   * @property {string|null} [proxyUrl=null]          - **Required.** URL of a same-origin backend that holds your API key.
   *   The plugin POSTs `{message, systemPrompt, model, temperature, maxTokens}` and expects `{text}` back.
   *   See `examples/proxy-node` or `examples/proxy-azure` for working implementations.
   * @property {string}  [placeholder]               - Input placeholder text.
   * @property {string}  [title='AI GeoJSON']        - Control panel title.
   * @property {string}  [buttonText='Ask']          - Submit button label.
   */
  L.Control.AiGeojson = L.Control.extend({

    /** @type {AiGeojsonOptions} */
    options: {

      // Where on the map the control appears.
      position: 'topright',

      model:  'gemini-2.0-flash',

      // System prompt prepended to every user message.
      // Leave null and the plugin generates one automatically from
      // maxPolygonCoordinates. Supply your own string to fully control
      // how the model behaves.
      systemPrompt: null,

      // Maximum output tokens. 8192 gives plenty of room for GeoJSON
      // while staying within typical free-tier limits.
      maxTokens: 8192,

      // Creativity dial — keep low for factual geographic data so the
      // model doesn't invent coordinates.
      temperature: 0.2,

      // Maximum coordinate pairs per polygon ring, injected into the
      // system prompt. Increase for more detailed outlines (uses more
      // tokens); decrease for faster / smaller responses.
      maxPolygonCoordinates: 50,

      // ----------------------------------------------------------------
      // Feature styling
      //
      // `style` is the base style applied to all vector features.
      // `polygonStyle` and `lineStyle` are merged on top for their
      // respective geometry types, so you can make polygons semi-
      // transparent while keeping lines fully opaque, for example.
      // ----------------------------------------------------------------

      // Base style — applies to all polygons and lines.
      style: {
        color:       '#3388ff',
        weight:      2,
        opacity:     0.8,
        fillOpacity: 0.25
      },

      // Optional style overrides for Polygon / MultiPolygon features.
      // Merged on top of `style`. Set to null to use the base style.
      polygonStyle: null,

      // Optional style overrides for LineString / MultiLineString
      // features. Merged on top of `style`. Set to null for base style.
      lineStyle: null,

      // How to render Point / MultiPoint features:
      //   'marker' — standard Leaflet pin marker (default)
      //   'circle' — circleMarker styled to match the vector layers
      pointStyle: 'marker',

      // Radius in pixels when pointStyle is 'circle'.
      pointRadius: 6,

      // Options passed directly to L.marker() for point features.
      // Use this to supply a custom icon:
      //   markerOptions: { icon: L.icon({ iconUrl: 'pin.png', ... }) }
      markerOptions: {},

      // Show a popup with feature properties when clicking any feature.
      popups: true,

      // Show a model-selector dropdown in the panel.
      // Requires modelListUrl — the proxy server must expose a GET endpoint
      // returning [{ id, name }] objects. See examples/proxy-node.
      modelPicker: false,

      // URL of the proxy's model-list endpoint, returning [{ id, name }].
      // Required for the modelPicker to work.
      //   modelListUrl: '/models'   (see examples/proxy-node/server.js)
      modelListUrl: null,

      // Required. URL of a same-origin backend that holds your API key.
      // The plugin POSTs { message, systemPrompt, model, temperature, maxTokens }
      // and expects { text: "<LLM reply>" } (or { error: "..." }) back.
      //
      // See examples/proxy-node or examples/proxy-azure for working implementations.
      proxyUrl: null,

      // Show a gear ⚙ icon in the header that opens an in-panel editor
      // for temperature, max tokens, polygon detail, point style, and
      // popup visibility. Settings take effect on the next query.
      settingsPanel: false,

      // ----------------------------------------------------------------
      // UI text
      // ----------------------------------------------------------------
      placeholder: 'Ask for geographic data or zoom to a place…',
      title:       'AI GeoJSON',
      // The submit button label. 'Ask' works for both data queries and
      // zoom/navigation requests.
      buttonText:  'Ask'
    },

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    initialize: function (options) {
      L.setOptions(this, options);

      // Track whether the caller supplied a custom system prompt; the
      // settings panel needs this to know if it can safely rebuild it.
      this._customSystemPrompt = !!(options && options.systemPrompt);

      // Build a system prompt if the caller didn't supply a custom one.
      if (!this.options.systemPrompt) {
        this.options.systemPrompt = buildSystemPrompt(this.options.maxPolygonCoordinates);
      }

      this._layers = {};   // id → { layerGroup, title, visible, query }
      this._allVisible = true;
      this._history = [];  // submitted queries, oldest-first
      this._historyIdx = -1; // -1 = not navigating
      this._historyDraft = ''; // saved draft while navigating history
    },

    onAdd: function (map) {
      this._map = map;
      var container = this._buildUI();
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      // Make the control draggable
      this._makeDraggable(container);
      // Kick off model list fetch after the DOM is ready
      if (this.options.modelPicker) this._fetchModelsForPicker();
      return container;
    },
    // Makes the control panel draggable after first drag
    _makeDraggable: function(container) {
      var header = container.querySelector('.leaflet-ai-geojson-header');
      if (!header) return;
      header.style.cursor = 'move';
      var isDragging = false;
      var startX, startY, startLeft, startTop;
      var hasDragged = false;
      var map = this._map;

      function toMapContainer() {
        if (container.parentNode !== map.getContainer()) {
          // Get current position relative to viewport
          var rect = container.getBoundingClientRect();
          // Remove from control corner and add to map container
          map.getContainer().appendChild(container);
          // Set absolute position based on current location
          container.style.position = 'absolute';
          container.style.left = rect.left + 'px';
          container.style.top = rect.top + 'px';
        }
      }

      header.addEventListener('mousedown', function(e) {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        var rect = container.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        document.body.style.userSelect = 'none';
        if (!hasDragged) {
          toMapContainer();
          hasDragged = true;
        }
      });

      document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        container.style.left = (startLeft + dx) + 'px';
        container.style.top = (startTop + dy) + 'px';
      });

      document.addEventListener('mouseup', function() {
        if (isDragging) {
          isDragging = false;
          document.body.style.userSelect = '';
        }
      });
    },

    onRemove: function () {
      this.clearAll();
    },

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Sends a natural-language query to the configured LLM and acts on the result.
     *
     * - If the model returns GeoJSON, a new layer group is added to the map.
     * - If the model returns a ZoomTo directive, the map pans/zooms with no layer.
     *
     * @param {string} text - The user's query, e.g. `"Show rivers in Germany"`.
     * @returns {Promise<{id:string, title:string, geojson:Object}|{type:'zoom', name:string}>}
     *   Resolves with layer metadata for a GeoJSON result, or a zoom descriptor.
     * @throws {Error} If the API call fails or the response cannot be parsed.
     */
    query: function (text) {
      var self = this;
      return this._callLLM(text).then(function (reply) {
        var parsed = extractGeoJSON(reply);

        // ZoomTo directive — navigate without drawing
        if (parsed && parsed.type === 'ZoomTo' && parsed.bbox) {
          var bb = parsed.bbox; // [minLon, minLat, maxLon, maxLat]
          self._map.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [30, 30] });
          return { type: 'zoom', name: parsed.name || text };
        }

        // Normal GeoJSON
        if (parsed && isGeoJSON(parsed)) {
          var title = deriveTitle(text, parsed);
          var id = self._addLayer(parsed, title, text);
          return { id: id, title: title, geojson: parsed };
        }

        // Nothing usable — give a meaningful error
        var msg;
        if (isTruncated(reply)) {
          msg = 'Response was cut off before the GeoJSON completed. Try a simpler query or reduce polygon detail.';
        } else if (reply && reply.length < 600) {
          msg = reply; // short plain-text explanation from the model
        } else {
          msg = 'Model did not return valid GeoJSON. Try rephrasing your query.';
        }
        var err = new Error(msg);
        err.llmMessage = msg;
        throw err;
      });
    },

    /**
     * Removes a single AI-generated layer group from the map.
     * @param {string} id - Layer ID returned by {@link query}.
     */
    removeLayer: function (id) {
      var entry = this._layers[id];
      if (!entry) return;
      this._map.removeLayer(entry.layerGroup);
      delete this._layers[id];
      this._renderList();
    },

    /**
     * Toggles the visibility of a single layer group.
     * @param {string}  id        - Layer ID returned by {@link query}.
     * @param {boolean} [visible] - Desired state. Omit to toggle current state.
     */
    toggleLayer: function (id, visible) {
      var entry = this._layers[id];
      if (!entry) return;
      if (typeof visible === 'undefined') visible = !entry.visible;
      entry.visible = visible;
      if (visible) {
        this._map.addLayer(entry.layerGroup);
      } else {
        this._map.removeLayer(entry.layerGroup);
      }
      this._renderList();
    },

    /**
     * Shows or hides every layer group at once.
     * @param {boolean} [visible] - Desired state. Omit to toggle current state.
     */
    toggleAll: function (visible) {
      if (typeof visible === 'undefined') visible = !this._allVisible;
      this._allVisible = visible;
      for (var id in this._layers) {
        this._layers[id].visible = visible;
        if (visible) {
          this._map.addLayer(this._layers[id].layerGroup);
        } else {
          this._map.removeLayer(this._layers[id].layerGroup);
        }
      }
      this._renderList();
    },

    /**
     * Removes all AI-generated layer groups from the map.
     */
    clearAll: function () {
      for (var id in this._layers) {
        this._map.removeLayer(this._layers[id].layerGroup);
      }
      this._layers = {};
      this._renderList();
    },

    // -------------------------------------------------------------------------
    // Internal — LLM dispatch
    // -------------------------------------------------------------------------

    // Routes the user's query to the configured proxyUrl backend.
    _callLLM: function (userMessage) {
      if (!this.options.proxyUrl) {
        return Promise.reject(new Error(
          '[leaflet.ai.geojson] proxyUrl is required. ' +
          'See examples/proxy-node or examples/proxy-azure for working implementations.'
        ));
      }
      return this._callProxy(userMessage);
    },

    // Expected request body: { message, systemPrompt, model, temperature, maxTokens }
    // Expected response:     { text: "<LLM reply string>" }  OR  { error: "..." }
    _callProxy: function (userMessage) {
      var opts = this.options;
      var body = JSON.stringify({
        message:      userMessage,
        systemPrompt: opts.systemPrompt,
        model:        opts.model,
        temperature:  opts.temperature,
        maxTokens:    opts.maxTokens
      });
      return fetch(opts.proxyUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    body
      })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              var err = new Error('Proxy error (' + res.status + '): ' + t);
              err.statusCode = res.status;
              throw err;
            });
          }
          return res.json();
        })
        .then(function (data) {
          if (data.error) throw new Error(data.error);
          if (typeof data.text === 'string') return data.text;
          throw new Error('Proxy response missing "text" field.');
        });
    },

    // -------------------------------------------------------------------------
    // Internal — Layers
    // -------------------------------------------------------------------------

    _addLayer: function (geojson, title, query) {
      var self = this;
      var id = uid();
      var group = L.geoJSON(geojson, {

        // Merge base style with any per-geometry-type overrides so callers
        // can style polygons and lines independently.
        style: function (feature) {
          var base = self.options.style;
          var geomType = feature.geometry ? feature.geometry.type : '';
          if ((geomType === 'Polygon' || geomType === 'MultiPolygon') && self.options.polygonStyle) {
            return L.extend({}, base, self.options.polygonStyle);
          }
          if ((geomType === 'LineString' || geomType === 'MultiLineString') && self.options.lineStyle) {
            return L.extend({}, base, self.options.lineStyle);
          }
          return base;
        },

        pointToLayer: function (feature, latlng) {
          if (self.options.pointStyle === 'circle') {
            // Circle markers inherit the vector style so points look
            // consistent with polygons and lines on the same layer.
            return L.circleMarker(latlng, L.extend(
              { radius: self.options.pointRadius },
              self.options.style
            ));
          }
          // Standard pin — pass markerOptions through so callers can
          // supply a custom icon if needed.
          return L.marker(latlng, self.options.markerOptions || {});
        },
        onEachFeature: function (feature, layer) {
          if (!self.options.popups) return;
          if (feature.properties) {
            var html = '';
            for (var key in feature.properties) {
              if (feature.properties.hasOwnProperty(key)) {
                html += '<b>' + escapeHtml(key) + ':</b> '
                  + escapeHtml(String(feature.properties[key])) + '<br>';
              }
            }
            if (html) layer.bindPopup(html);
          }
        }
      }).addTo(this._map);

      this._layers[id] = {
        layerGroup: group,
        title: title,
        visible: true,
        query: query
      };

      this._renderList();

      // Pan and zoom to show the new data. getBounds() throws on empty
      // collections, so wrap it just in case.
      try {
        var bounds = group.getBounds();
        if (bounds.isValid()) this._map.fitBounds(bounds, { padding: [30, 30] });
      } catch (_) { /* empty or point-only layer — nothing to fit */ }

      return id;
    },

    // -------------------------------------------------------------------------
    // Internal — UI
    // -------------------------------------------------------------------------

    _buildUI: function () {
      var self = this;

      // Main wrapper
      var container = L.DomUtil.create('div', 'leaflet-ai-geojson');
      this._container = container;

      // Header / collapse toggle
      var header = L.DomUtil.create('div', 'leaflet-ai-geojson-header', container);
      var titleSpan = L.DomUtil.create('span', '', header);
      titleSpan.textContent = this.options.title;

      // Right-side header buttons (gear + collapse) sit in a wrapper so
      // justify-content: space-between always puts them flush right.
      var headerActions = L.DomUtil.create('div', 'leaflet-ai-geojson-header-actions', header);

      if (this.options.settingsPanel) {
        var gearBtn = L.DomUtil.create('button', 'leaflet-ai-geojson-gear-btn', headerActions);
        gearBtn.textContent = '⚙';
        gearBtn.title = 'Settings';
        gearBtn.type = 'button';
        this._gearBtn = gearBtn;
        gearBtn.addEventListener('click', function () { self._toggleSettings(); });
      }

      var collapseBtn = L.DomUtil.create('button', 'leaflet-ai-geojson-collapse-btn', headerActions);
      collapseBtn.textContent = '−';
      collapseBtn.title = 'Collapse';
      collapseBtn.type = 'button';

      // Body (collapsible)
      var body = L.DomUtil.create('div', 'leaflet-ai-geojson-body', container);
      this._body = body;

      collapseBtn.addEventListener('click', function () {
        var hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        collapseBtn.textContent = hidden ? '−' : '+';
        collapseBtn.title = hidden ? 'Collapse' : 'Expand';
      });

      // Model row: interactive picker when modelPicker:true, static text otherwise
      if (this.options.modelPicker) {
        this._buildModelPickerRow(body);
      } else {
        var modelLabel = L.DomUtil.create('div', 'leaflet-ai-geojson-model-static', body);
        modelLabel.textContent = this.options.model || '';
        this._modelStaticLabel = modelLabel;
      }

      // Settings panel (hidden until user clicks the gear button)
      if (this.options.settingsPanel) {
        this._buildSettingsPanel(body);
      }

      // Chat area (scrollable message log)
      var chatArea = L.DomUtil.create('div', 'leaflet-ai-geojson-chat', body);
      this._chatArea = chatArea;

      // Indeterminate progress bar — visible during a query, hidden otherwise
      var progress = L.DomUtil.create('div', 'leaflet-ai-geojson-progress', body);
      L.DomUtil.create('div', 'leaflet-ai-geojson-progress-bar', progress);
      this._progressBar = progress;

      // Input row
      var inputRow = L.DomUtil.create('div', 'leaflet-ai-geojson-input-row', body);
      var input = L.DomUtil.create('input', 'leaflet-ai-geojson-input', inputRow);
      input.type = 'text';
      input.placeholder = this.options.placeholder;
      this._input = input;

      var btn = L.DomUtil.create('button', 'leaflet-ai-geojson-btn', inputRow);
      btn.textContent = this.options.buttonText;
      btn.type = 'button';
      this._submitBtn = btn;

      var doQuery = function () {
        var text = input.value.trim();
        if (!text) return;
        self._submitQuery(text);
      };

      btn.addEventListener('click', doQuery);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          doQuery();
        } else if (e.key === 'ArrowUp') {
          if (!self._history.length) return;
          e.preventDefault();
          if (self._historyIdx === -1) {
            self._historyDraft = input.value;
            self._historyIdx = self._history.length - 1;
          } else if (self._historyIdx > 0) {
            self._historyIdx--;
          }
          input.value = self._history[self._historyIdx];
        } else if (e.key === 'ArrowDown') {
          if (self._historyIdx === -1) return;
          e.preventDefault();
          if (self._historyIdx < self._history.length - 1) {
            self._historyIdx++;
            input.value = self._history[self._historyIdx];
          } else {
            self._historyIdx = -1;
            input.value = self._historyDraft;
          }
        }
      });

      // Layer list area
      var listHeader = L.DomUtil.create('div', 'leaflet-ai-geojson-list-header', body);

      var toggleAllBtn = L.DomUtil.create('button', 'leaflet-ai-geojson-btn-sm', listHeader);
      toggleAllBtn.textContent = 'Toggle All';
      toggleAllBtn.title = 'Show / hide all layers';
      toggleAllBtn.type = 'button';
      toggleAllBtn.addEventListener('click', function () { self.toggleAll(); });

      var clearAllBtn = L.DomUtil.create('button', 'leaflet-ai-geojson-btn-sm leaflet-ai-geojson-btn-danger', listHeader);
      clearAllBtn.textContent = 'Clear All';
      clearAllBtn.title = 'Remove all layers';
      clearAllBtn.type = 'button';
      clearAllBtn.addEventListener('click', function () {
        self.clearAll();
        self._chatArea.innerHTML = '';
      });

      var layerList = L.DomUtil.create('div', 'leaflet-ai-geojson-layers', body);
      this._layerList = layerList;

      return container;
    },

    // Builds the compact model-selector row shown at the top of the body
    // when modelPicker: true. The select is populated by _fetchModelsForPicker.
    _buildModelPickerRow: function (body) {
      var self = this;
      var row = L.DomUtil.create('div', 'leaflet-ai-geojson-model-row', body);

      var label = L.DomUtil.create('span', 'leaflet-ai-geojson-model-label', row);
      label.textContent = 'Model:';

      var spinner = L.DomUtil.create('div', 'leaflet-ai-geojson-spinner', row);
      this._modelSpinner = spinner;

      var sel = L.DomUtil.create('select', 'leaflet-ai-geojson-model-select', row);
      var placeholder = document.createElement('option');
      placeholder.textContent = 'Loading…';
      sel.appendChild(placeholder);
      sel.disabled = true;
      this._modelSelect = sel;

      var hint = L.DomUtil.create('span', 'leaflet-ai-geojson-model-hint', row);
      this._modelHint = hint;

      sel.addEventListener('change', function () {
        self.options.model = sel.value;
        var prev = L.Control.AiGeojson.isPreviewModel(sel.value);
        hint.textContent = prev ? '\u26a0 Low RPM' : '';
        hint.title = prev ? 'Preview models have very low free-tier RPM (2-5/min).' : '';
      });
    },

    // Fetches the model list from the configured provider and populates
    // the model picker select. Stable models are shown first; preview
    // models are grouped below so they’re easy to avoid by default.
    _fetchModelsForPicker: function () {
      var self = this;
      var opts = this.options;

      var onModels = function (items) {
        var sel = self._modelSelect;
        var hint = self._modelHint;
        if (!sel) return;
        if (self._modelSpinner) self._modelSpinner.style.display = 'none';

        var stable  = items.filter(function (m) { return !L.Control.AiGeojson.isPreviewModel(m.id); });
        var preview = items.filter(function (m) { return  L.Control.AiGeojson.isPreviewModel(m.id); });
        var primary = stable.length ? stable : items;

        sel.innerHTML = '';
        primary.forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          sel.appendChild(opt);
        });

        // Preview models go in a labelled group so they’re visible but
        // clearly flagged as higher-risk choices.
        if (stable.length && preview.length) {
          var grp = document.createElement('optgroup');
          grp.label = 'Preview / experimental (low RPM)';
          preview.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            grp.appendChild(opt);
          });
          sel.appendChild(grp);
        }

        sel.disabled = false;

        // Pre-select the current options.model if present in the list;
        // otherwise fall back to the first stable entry.
        var found = false;
        for (var i = 0; i < sel.options.length; i++) {
          if (sel.options[i].value === opts.model) { sel.selectedIndex = i; found = true; break; }
        }
        if (!found && sel.options.length) {
          sel.selectedIndex = 0;
          opts.model = sel.options[0].value;
        }

        if (hint) {
          var prev = L.Control.AiGeojson.isPreviewModel(sel.value);
          hint.textContent = prev ? '\u26a0 Low RPM' : '';
        }
      };

      var onError = function (err) {
        if (self._modelSpinner) self._modelSpinner.style.display = 'none';
        if (self._modelSelect) {
          self._modelSelect.innerHTML = '';
          var opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'Error: ' + err.message;
          self._modelSelect.appendChild(opt);
        }
      };

      // modelListUrl takes priority — supports proxy mode with no client-side key.
      if (opts.modelListUrl) {
        fetch(opts.modelListUrl)
          .then(function (r) {
            if (!r.ok) throw new Error('Model list request failed (' + r.status + ')');
            return r.json();
          })
          .then(onModels)
          .catch(onError);
        return;
      }
    },

    // Opens or closes the settings panel and toggles the active state on the
    // gear button. No-op if settingsPanel option was not enabled.
    _toggleSettings: function () {
      var panel = this._settingsPanel;
      if (!panel) return;
      var isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : '';
      if (this._gearBtn) {
        if (isOpen) {
          this._gearBtn.classList.remove('leaflet-ai-geojson-gear-btn-active');
        } else {
          this._gearBtn.classList.add('leaflet-ai-geojson-gear-btn-active');
        }
      }
    },

    // Builds the in-panel settings editor shown when settingsPanel: true.
    // Each setting mutates options.* immediately so the next query picks it up.
    _buildSettingsPanel: function (body) {
      var self = this;
      var opts = this.options;

      var panel = L.DomUtil.create('div', 'leaflet-ai-geojson-settings', body);
      panel.style.display = 'none';
      this._settingsPanel = panel;

      // --- Temperature ---
      var tempRow = this._makeSettingsRow(panel, 'Temperature');
      var tempSlider = L.DomUtil.create('input', 'leaflet-ai-geojson-settings-range', tempRow.ctrl);
      tempSlider.type = 'range'; tempSlider.min = '0'; tempSlider.max = '1'; tempSlider.step = '0.05';
      tempSlider.value = String(opts.temperature);
      var tempVal = L.DomUtil.create('span', 'leaflet-ai-geojson-settings-val', tempRow.ctrl);
      tempVal.textContent = String(opts.temperature);
      tempSlider.addEventListener('input', function () {
        opts.temperature = parseFloat(tempSlider.value);
        tempVal.textContent = tempSlider.value;
      });

      // --- Max tokens ---
      var tokRow = this._makeSettingsRow(panel, 'Max tokens');
      var tokSel = L.DomUtil.create('select', 'leaflet-ai-geojson-settings-select', tokRow.ctrl);
      [1024, 2048, 4096, 8192, 16384, 32768].forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = (v / 1024) + 'k';
        if (v === opts.maxTokens) opt.selected = true;
        tokSel.appendChild(opt);
      });
      tokSel.addEventListener('change', function () { opts.maxTokens = parseInt(tokSel.value, 10); });

      // --- Polygon detail ---
      var polyRow = this._makeSettingsRow(panel, 'Polygon detail');
      var polySel = L.DomUtil.create('select', 'leaflet-ai-geojson-settings-select', polyRow.ctrl);
      [{v:20,l:'Low (20)'},{v:50,l:'Med (50)'},{v:100,l:'High (100)'},{v:200,l:'Max (200)'}].forEach(function (item) {
        var opt = document.createElement('option');
        opt.value = String(item.v);
        opt.textContent = item.l;
        if (item.v === opts.maxPolygonCoordinates) opt.selected = true;
        polySel.appendChild(opt);
      });
      polySel.addEventListener('change', function () {
        opts.maxPolygonCoordinates = parseInt(polySel.value, 10);
        // Rebuild the system prompt only when no custom prompt was supplied.
        if (!self._customSystemPrompt) {
          opts.systemPrompt = buildSystemPrompt(opts.maxPolygonCoordinates);
        }
      });

      // --- Point style ---
      var ptRow = this._makeSettingsRow(panel, 'Point style');
      var radiosWrap = L.DomUtil.create('div', 'leaflet-ai-geojson-settings-radios', ptRow.ctrl);
      var radioName = uid();
      ['marker', 'circle'].forEach(function (val) {
        var lbl = document.createElement('label');
        lbl.className = 'leaflet-ai-geojson-settings-radio-label';
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = radioName; radio.value = val;
        if (opts.pointStyle === val) radio.checked = true;
        radio.addEventListener('change', function () { if (radio.checked) opts.pointStyle = val; });
        lbl.appendChild(radio);
        lbl.appendChild(document.createTextNode('\u00a0' + val.charAt(0).toUpperCase() + val.slice(1)));
        radiosWrap.appendChild(lbl);
      });

      // --- Popups ---
      var popRow = this._makeSettingsRow(panel, 'Popups');
      var popLbl = document.createElement('label');
      popLbl.className = 'leaflet-ai-geojson-settings-checkbox-label';
      var popCb = document.createElement('input');
      popCb.type = 'checkbox'; popCb.checked = opts.popups;
      popCb.addEventListener('change', function () { opts.popups = popCb.checked; });
      popLbl.appendChild(popCb);
      popLbl.appendChild(document.createTextNode('\u00a0Show on click'));
      popRow.ctrl.appendChild(popLbl);
    },

    // Helper: creates a labelled settings row and returns { row, ctrl }.
    _makeSettingsRow: function (panel, labelText) {
      var row = L.DomUtil.create('div', 'leaflet-ai-geojson-settings-row', panel);
      var lbl = L.DomUtil.create('span', 'leaflet-ai-geojson-settings-label', row);
      lbl.textContent = labelText;
      var ctrl = L.DomUtil.create('div', 'leaflet-ai-geojson-settings-ctrl', row);
      return { row: row, ctrl: ctrl };
    },

    // Called once per second during an automatic rate-limit retry countdown.
    // Updates the button label so the user can see how long to wait.
    _onRetrying: function (secondsLeft) {      this._setLoading(true, 'Retrying in ' + secondsLeft + 's…');
    },

    _submitQuery: function (text) {
      var self = this;

      // Append user message and record in history
      this._appendMessage('user', text);
      if (this._history[this._history.length - 1] !== text) {
        this._history.push(text);
      }
      this._historyIdx = -1;
      this._historyDraft = '';
      this._input.value = '';
      this._setLoading(true);
      var thinkingEl = this._appendThinking();

      this.query(text)
        .then(function (result) {
          if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
          if (result.type === 'zoom') {
            self._appendMessage('assistant', '🔍 Zoomed to: ' + result.name);
          } else {
            self._appendMessage('assistant', '✔ Layer added: ' + result.title);
          }
        })
        .catch(function (err) {
          if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
          var msg;
          if (err.dailyQuotaExhausted) {
            msg = '⛔ Daily quota exhausted for this model. Try a different model or wait until midnight Pacific time.';
          } else if (err.statusCode === 429) {
            msg = '⏱ Rate limited. ' + (err.message || '');
          } else {
            msg = err.llmMessage || err.message || 'Unknown error';
          }
          self._appendMessage('error', msg);
        })
        .finally(function () {
          self._setLoading(false);
        });
    },

    _appendMessage: function (role, text) {
      var div = L.DomUtil.create('div', 'leaflet-ai-geojson-msg leaflet-ai-geojson-msg-' + role, this._chatArea);
      div.textContent = text;
      this._chatArea.scrollTop = this._chatArea.scrollHeight;
    },

    _appendThinking: function () {
      var div = L.DomUtil.create('div', 'leaflet-ai-geojson-msg leaflet-ai-geojson-msg-thinking', this._chatArea);
      div.appendChild(document.createTextNode('Thinking'));
      L.DomUtil.create('span', 'leaflet-ai-geojson-thinking-dots', div);
      this._chatArea.scrollTop = this._chatArea.scrollHeight;
      return div;
    },

    _setLoading: function (loading, label) {
      this._submitBtn.disabled = loading;
      this._input.disabled = loading;
      if (loading) {
        this._submitBtn.textContent = label || '…';
        if (this._progressBar) L.DomUtil.addClass(this._progressBar, 'leaflet-ai-geojson-progress-active');
      } else {
        this._submitBtn.textContent = this.options.buttonText;
        if (this._progressBar) L.DomUtil.removeClass(this._progressBar, 'leaflet-ai-geojson-progress-active');
      }
    },

    _renderList: function () {
      var list = this._layerList;
      if (!list) return;
      list.innerHTML = '';

      for (var id in this._layers) {
        if (!this._layers.hasOwnProperty(id)) continue;
        this._renderListItem(list, id, this._layers[id]);
      }
    },

    _renderListItem: function (parent, id, entry) {
      var self = this;
      var row = L.DomUtil.create('div', 'leaflet-ai-geojson-layer-row', parent);

      var cb = L.DomUtil.create('input', '', row);
      cb.type = 'checkbox';
      cb.checked = entry.visible;
      cb.title = 'Toggle visibility';
      cb.addEventListener('change', function () { self.toggleLayer(id, cb.checked); });

      var label = L.DomUtil.create('span', 'leaflet-ai-geojson-layer-label', row);
      label.textContent = entry.title;
      label.title = entry.query;

      var removeBtn = L.DomUtil.create('button', 'leaflet-ai-geojson-btn-xs leaflet-ai-geojson-btn-danger', row);
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove layer';
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', function () { self.removeLayer(id); });
    }
  });

  // ---------------------------------------------------------------------------
  // Static utilities — model discovery
  //
  // These live on the class so demos and integrations don't have to
  // re-implement the API calls or the filtering rules.
  // ---------------------------------------------------------------------------

  // Known stable model IDs used for sorting and preview detection.
  // Update this list as Google releases new stable models.
  L.Control.AiGeojson.STABLE_IDS = [
    'gemini-2.5-pro', 'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'
  ];

  /**
   * Returns `true` if a Gemini model ID looks like a preview or experimental
   * build. Preview models typically have very low free-tier RPM (2–5/min).
   *
   * IDs in {@link L.Control.AiGeojson.STABLE_IDS} are always considered stable
   * regardless of their name.
   *
   * @param {string} id - Model ID, e.g. `'gemini-2.5-flash-preview-04-17'`.
   * @returns {boolean}
   */
  L.Control.AiGeojson.isPreviewModel = function (id) {
    if (!id) return false;
    // IDs in the stable list are never considered preview regardless of name
    if (L.Control.AiGeojson.STABLE_IDS.indexOf(id) !== -1) return false;
    // Date-stamped snapshots (e.g. gemini-2.5-flash-preview-04-17),
    // anything labelled preview/exp/experimental, or "latest" aliases
    return /preview|exp(erimental)?|latest|\d{4,}/i.test(id);
  };

  /**
   * Factory function — preferred way to create a control instance.
   * @param {AiGeojsonOptions} options
   * @returns {L.Control.AiGeojson}
   * @example
   * L.control.aiGeojson({
   *   proxyUrl:     '/llm',
   *   modelListUrl: '/models',
   *   model:        'gemini-2.5-flash'
   * }).addTo(map);
   */
  L.control.aiGeojson = function (options) {
    return new L.Control.AiGeojson(options);
  };

  return L.Control.AiGeojson;
});
