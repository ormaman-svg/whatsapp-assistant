'use strict';

const axios = require('axios');

const BASE_URL = 'https://maps.googleapis.com/maps/api';

function getApiKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not configured. Ask the admin to add it.');
  return key;
}

async function searchPlaces(query, { location, radius = 5000 } = {}) {
  const params = {
    query,
    key: getApiKey(),
    language: 'he',
  };
  if (location) {
    params.location = `${location.lat},${location.lng}`;
    params.radius = radius;
  }

  const { data } = await axios.get(`${BASE_URL}/place/textsearch/json`, { params, timeout: 10000 });

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API error: ${data.status} - ${data.error_message || ''}`);
  }

  return (data.results || []).slice(0, 5).map((p) => ({
    name: p.name,
    address: p.formatted_address,
    rating: p.rating || null,
    totalRatings: p.user_ratings_total || 0,
    priceLevel: p.price_level != null ? '💰'.repeat(p.price_level) : null,
    openNow: p.opening_hours?.open_now ?? null,
    location: p.geometry?.location,
    placeId: p.place_id,
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
  }));
}

async function getDirections(origin, destination, { mode = 'driving' } = {}) {
  const params = {
    origin,
    destination,
    mode,
    key: getApiKey(),
    language: 'he',
    departure_time: mode === 'transit' ? 'now' : undefined,
  };

  const { data } = await axios.get(`${BASE_URL}/directions/json`, { params, timeout: 10000 });

  if (data.status !== 'OK') {
    throw new Error(`Directions API error: ${data.status} - ${data.error_message || ''}`);
  }

  const route = data.routes[0];
  const leg = route.legs[0];

  return {
    origin: leg.start_address,
    destination: leg.end_address,
    distance: leg.distance.text,
    duration: leg.duration.text,
    durationInTraffic: leg.duration_in_traffic?.text || null,
    steps: leg.steps.slice(0, 10).map((s) => ({
      instruction: s.html_instructions?.replace(/<[^>]+>/g, ''),
      distance: s.distance.text,
      duration: s.duration.text,
    })),
    mapsUrl: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${mode}`,
  };
}

async function geocode(address) {
  const { data } = await axios.get(`${BASE_URL}/geocode/json`, {
    params: { address, key: getApiKey() },
    timeout: 10000,
  });
  if (data.status !== 'OK' || !data.results?.length) return null;
  const result = data.results[0];
  return {
    address: result.formatted_address,
    location: result.geometry.location,
  };
}

module.exports = { searchPlaces, getDirections, geocode };
