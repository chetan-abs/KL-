import React, { useMemo } from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

/**
 * JSON.stringify is not an HTML escape.
 *
 * Marker data carries employee names straight out of the database, and they were
 * interpolated into the page — both into the <script> block, where a name
 * containing </script> ends it early, and into a Leaflet popup, which renders
 * its content as markup. A name is text an administrator types; treating it as
 * code is how stored XSS works.
 *
 * The data is serialised with the two characters that can break out of a script
 * block escaped, and the popup is given text rather than HTML.
 */
function toScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export default function LeafletMap({ 
  markers = [], 
  polyLine = [],
  style
}) {
  const htmlContent = useMemo(() => {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <style>
          body { padding: 0; margin: 0; }
          html, body, #map { height: 100%; width: 100%; }
          .custom-div-icon {
            background-color: transparent;
            text-align: center;
            border: none;
          }
          .marker-pin {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            border: 2px solid white;
            box-shadow: 0 0 4px rgba(0,0,0,0.4);
            display: inline-block;
          }
          .marker-label {
            font-size: 10px;
            font-weight: bold;
            color: #333;
            background: white;
            padding: 1px 4px;
            border-radius: 4px;
            margin-top: -4px;
            box-shadow: 0 0 2px rgba(0,0,0,0.3);
            white-space: nowrap;
          }
        </style>
      </head>
      <body>
        <div id="map"></div>
        <script>
          function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, function (c) {
              return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
          }

          var map = L.map('map', { zoomControl: false });
          L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: '© OSM'
          }).addTo(map);

          L.control.zoom({ position: 'bottomright' }).addTo(map);

          var markersData = ${toScriptJson(markers)};
          var polyLineData = ${toScriptJson(polyLine)};
          
          var bounds = L.latLngBounds();
          var hasBounds = false;

          // Draw Polyline
          if (polyLineData && polyLineData.length > 0) {
            var latlngs = polyLineData.map(function(p) { return [p.lat, p.lng]; });
            var polyline = L.polyline(latlngs, {color: '#ef4444', weight: 2}).addTo(map);
            
            polyLineData.forEach(function(p) {
              bounds.extend([p.lat, p.lng]);
              hasBounds = true;
            });
          }

          // Draw Markers
          if (markersData && markersData.length > 0) {
            markersData.forEach(function(m) {
              var color = m.color || '#3b82f6';
              var html = '<div class="custom-div-icon">' +
                         '<div class="marker-pin" style="background-color: ' + color + ';"></div>' +
                         (m.label ? '<div class="marker-label">' + escapeHtml(m.label) + '</div>' : '') +
                         '</div>';
                         
              var icon = L.divIcon({
                className: 'custom-div-icon',
                html: html,
                iconSize: [30, 42],
                iconAnchor: [15, 15]
              });

              var marker = L.marker([m.lat, m.lng], {icon: icon}).addTo(map);
              
              if (m.title) {
                // setContent with a DOM node, so the name is text under every
                // circumstance rather than markup that happens to look safe.
                var popup = document.createElement('div');
                var strong = document.createElement('strong');
                strong.textContent = m.title;
                popup.appendChild(strong);
                if (m.subtitle) {
                  popup.appendChild(document.createElement('br'));
                  popup.appendChild(document.createTextNode(m.subtitle));
                }
                marker.bindPopup(popup);
              }

              bounds.extend([m.lat, m.lng]);
              hasBounds = true;
            });
          }

          if (hasBounds) {
            map.fitBounds(bounds, { padding: [30, 30] });
          } else {
            map.setView([20.5937, 78.9629], 5); // Default to India
          }
        </script>
      </body>
      </html>
    `;
  }, [markers, polyLine]);

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.container, style]}>
        <iframe
          srcDoc={htmlContent}
          style={{ width: '100%', height: '100%', border: 0 }}
          title="Leaflet Map"
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <WebView
        source={{ html: htmlContent }}
        style={{ flex: 1 }}
        scrollEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden'
  }
});
