// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const dotenv = require("dotenv");

const {
  storeAuthToken,
  getAuthToken,
  getValidAccessToken,
  storeActivities,
  getActivities,
  getActivity,
  activityExists,
  getActivityCount,
} = require("./dynamodb");

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables (you'll need to set these)
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_REDIRECT_URI =
  process.env.STRAVA_REDIRECT_URI ||
  "http://localhost:3001/auth/strava/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Strava API base URL
const STRAVA_API_BASE = "https://www.strava.com/api/v3";

// ========================================
// STRAVA OAUTH ROUTES
// ========================================

// Initiate Strava OAuth
app.get("/auth/strava", (req, res) => {
  const scope = "read,activity:read_all";
  const stravaAuthUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${STRAVA_REDIRECT_URI}&approval_prompt=force&scope=${scope}`;

  console.log("Redirecting to Strava OAuth:", stravaAuthUrl);
  res.redirect(stravaAuthUrl);
});

// Handle Strava OAuth callback
app.get("/auth/strava/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("Strava OAuth error:", error);
    return res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }

  if (!code) {
    console.error("No authorization code received");
    return res.redirect(`${FRONTEND_URL}?error=no_code`);
  }

  try {
    console.log("Exchanging code for access token...");

    const tokenResponse = await axios.post(
      "https://www.strava.com/oauth/token",
      {
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
      }
    );

    const { access_token, refresh_token, expires_at, athlete } =
      tokenResponse.data;

    console.log("Successfully authenticated athlete:", athlete.id);

    // Store tokens in DynamoDB
    await storeAuthToken(athlete.id, {
      access_token,
      refresh_token,
      expires_at,
      athlete_info: athlete,
    });

    res.redirect(`${FRONTEND_URL}?auth=success&athlete_id=${athlete.id}`);
  } catch (error) {
    console.error(
      "Error exchanging code for token:",
      error.response?.data || error.message
    );
    res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
  }
});

app.get("/auth/status/:athlete_id", async (req, res) => {
  const { athlete_id } = req.params;

  try {
    const authData = await getAuthToken(athlete_id);

    if (!authData) {
      return res
        .status(404)
        .json({ authenticated: false, message: "No authentication found" });
    }

    // Check if token is still valid (with buffer)
    const now = Math.floor(Date.now() / 1000);
    const isValid = !authData.expires_at || now + 300 < authData.expires_at;

    res.json({
      authenticated: true,
      athlete_info: authData.athlete_info,
      token_valid: isValid,
      expires_at: authData.expires_at,
    });
  } catch (error) {
    console.error("Error checking auth status:", error);
    res.status(500).json({ error: "Failed to check authentication status" });
  }
});

// ========================================
// ACTIVITY ROUTES
// ========================================

// Get all activities for authenticated user
app.get("/activities", async (req, res) => {
  const { athlete_id, activity_type, race_filter } = req.query;

  if (!athlete_id) {
    return res.status(400).json({ error: "athlete_id is required" });
  }

  try {
    // Verify authentication
    const authData = await getAuthToken(athlete_id);
    if (!authData) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    console.log("Loading activities from DynamoDB for athlete:", athlete_id);

    // Get activities from DynamoDB with filtering
    const activities = await getActivities(athlete_id, {
      activity_type,
      race_filter,
    });

    const activityCount = await getActivityCount(athlete_id);

    res.json({
      activities,
      cached: true, // Always from DynamoDB now
      total: activityCount,
      returned: activities.length,
    });
  } catch (error) {
    console.error("Error fetching activities:", error);

    if (error.message.includes("No authentication data found")) {
      return res.status(401).json({ error: "Authentication expired" });
    }

    res.status(500).json({ error: "Failed to fetch activities" });
  }
});

// Sync activities from Strava (non-blocking)
app.post("/activities/sync", async (req, res) => {
  const { athlete_id, full_sync = false } = req.body;

  if (!athlete_id) {
    return res.status(400).json({ error: "athlete_id is required" });
  }

  try {
    // Verify authentication first
    const accessToken = await getValidAccessToken(athlete_id);

    // Respond immediately that sync has started
    res.json({
      message: "Sync started in background",
      sync_type: full_sync ? "full" : "incremental",
      status: "in_progress",
      started_at: new Date().toISOString(),
    });

    // Start sync in background (don't await)
    performBackgroundSync(athlete_id, accessToken, full_sync);
  } catch (error) {
    console.error("Error starting sync:", error);

    if (error.message.includes("No authentication data found")) {
      return res.status(401).json({ error: "Authentication expired" });
    }

    res.status(500).json({ error: "Failed to start sync" });
  }
});

// Background sync function
async function performBackgroundSync(athlete_id, accessToken, full_sync) {
  try {
    console.log(
      `Starting background ${
        full_sync ? "full" : "incremental"
      } sync for athlete: ${athlete_id}`
    );

    // Fetch activities from Strava
    const newActivities = await fetchStravaActivities(accessToken);

    let storedCount = 0;
    let skippedCount = 0;

    if (full_sync) {
      const activitiesWithAthleteId = newActivities.map((activity) => ({
        ...activity,
        athlete_id: athlete_id.toString(),
      }));

      storedCount = await storeActivities(activitiesWithAthleteId);
    } else {
      console.log("Performing incremental sync - checking for duplicates");

      const newActivitiesToStore = [];

      for (const activity of newActivities) {
        const exists = await activityExists(activity.id);
        if (!exists) {
          newActivitiesToStore.push({
            ...activity,
            athlete_id: athlete_id.toString(),
          });
        } else {
          skippedCount++;
        }
      }

      if (newActivitiesToStore.length > 0) {
        storedCount = await storeActivities(newActivitiesToStore);
      }
    }

    const totalActivities = await getActivityCount(athlete_id);

    console.log(`🎉 Background sync complete for athlete ${athlete_id}:`);
    console.log(`   - New activities: ${storedCount}`);
    console.log(`   - Existing skipped: ${skippedCount}`);
    console.log(`   - Total activities: ${totalActivities}`);
  } catch (error) {
    console.error(
      `❌ Background sync failed for athlete ${athlete_id}:`,
      error
    );
  }
}

// Get sync status (you can expand this to track actual sync progress if needed)
app.get("/activities/sync/status/:athlete_id", async (req, res) => {
  const { athlete_id } = req.params;

  try {
    const totalActivities = await getActivityCount(athlete_id);

    res.json({
      status: "completed", // For now, just return completed
      total_activities: totalActivities,
      last_checked: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

// Get specific activity details with full GPX data
app.get("/activities/:id", async (req, res) => {
  const { id } = req.params;
  const { athlete_id } = req.query;

  if (!athlete_id) {
    return res.status(400).json({ error: "athlete_id is required" });
  }

  try {
    // First try to get from DynamoDB
    let activity = await getActivity(id);

    if (activity && activity.coordinates && activity.coordinates.length > 20) {
      // Activity found in DynamoDB with detailed coordinates
      console.log("Returning detailed activity from DynamoDB:", id);
      return res.json(activity);
    }

    // If not found or no detailed coordinates, fetch from Strava
    console.log("Fetching detailed activity from Strava:", id);

    const accessToken = await getValidAccessToken(athlete_id);

    const response = await axios.get(`${STRAVA_API_BASE}/activities/${id}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const stravaActivity = response.data;

    // Virtual activity checks
    if (
      stravaActivity.trainer ||
      stravaActivity.manual ||
      stravaActivity.type === "VirtualRide" ||
      stravaActivity.type === "VirtualRun" ||
      !stravaActivity.start_latlng ||
      !stravaActivity.map?.polyline
    ) {
      return res
        .status(404)
        .json({ error: "Activity not found or is virtual" });
    }

    // Get the polyline data and decode it
    const coordinates = stravaActivity.map?.polyline
      ? decodePolyline(stravaActivity.map.polyline)
      : [];

    if (coordinates.length < 3) {
      return res
        .status(404)
        .json({ error: "Activity has insufficient GPS data" });
    }

    // Use first coordinate from polyline for country detection
    const firstCoordinate = coordinates[0];
    const countryDetectionPoint = [firstCoordinate.lat, firstCoordinate.lng];

    const detailedActivity = {
      id: stravaActivity.id,
      athlete_id: athlete_id.toString(),
      name: stravaActivity.name,
      type: mapStravaType(stravaActivity.type),
      distance: (stravaActivity.distance / 1000).toFixed(1),
      time: formatDuration(stravaActivity.moving_time),
      country: await getCountryFromCoordinates(countryDetectionPoint),
      isRace:
        stravaActivity.workout_type === 1 ||
        stravaActivity.name.toLowerCase().includes("race"),
      coordinates: coordinates,
      elevation_gain: stravaActivity.total_elevation_gain,
      average_speed: stravaActivity.average_speed,
      start_date: stravaActivity.start_date,
    };

    // Store the detailed activity in DynamoDB for future requests
    try {
      await storeActivities([detailedActivity]);
      console.log("Stored detailed activity in DynamoDB");
    } catch (storeError) {
      console.warn("Failed to store detailed activity:", storeError);
    }

    res.json(detailedActivity);
  } catch (error) {
    console.error(
      "Error fetching activity details:",
      error.response?.data || error.message
    );

    if (error.response?.status === 401) {
      return res.status(401).json({ error: "Strava token expired" });
    }

    res.status(500).json({ error: "Failed to fetch activity details" });
  }
});

// ========================================
// UTILITY FUNCTIONS
// ========================================

// Fetch activities from Strava API
async function fetchStravaActivities(accessToken) {
  const activities = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    console.log(`Fetching activities page ${page}...`);

    const response = await axios.get(`${STRAVA_API_BASE}/athlete/activities`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params: {
        page: page,
        per_page: perPage,
      },
    });

    const pageActivities = response.data;

    if (pageActivities.length === 0) {
      break; // No more activities
    }

    for (const activity of pageActivities) {
      // Skip virtual activities - comprehensive filtering
      if (
        activity.trainer ||
        activity.manual ||
        (activity.commute === false && activity.trainer === true) ||
        activity.type === "VirtualRide" ||
        activity.type === "VirtualRun" ||
        activity.name.toLowerCase().includes("zwift") ||
        activity.name.toLowerCase().includes("peloton") ||
        activity.name.toLowerCase().includes("virtual") ||
        activity.name.toLowerCase().includes("indoor") ||
        activity.name.toLowerCase().includes("trainer") ||
        activity.name.toLowerCase().includes("treadmill") ||
        !activity.start_latlng ||
        activity.start_latlng.length === 0
      ) {
        console.log(
          `Skipping virtual/indoor activity: ${activity.name} (${activity.type})`
        );
        continue;
      }

      // Only include runs, rides, and swims with GPS data
      const activityType = mapStravaType(activity.type);
      if (!["run", "ride", "swim"].includes(activityType)) {
        console.log(`Skipping non-supported activity type: ${activity.type}`);
        continue;
      }

      // Additional check: ensure activity has meaningful GPS data
      if (
        !activity.map ||
        (!activity.map.summary_polyline && !activity.map.polyline)
      ) {
        console.log(`Skipping activity without GPS data: ${activity.name}`);
        continue;
      }

      // Get simplified coordinates from summary polyline
      const coordinates = activity.map?.summary_polyline
        ? decodePolyline(activity.map.summary_polyline)
        : [];

      // Skip if no coordinates or very few coordinates (likely indoor)
      if (coordinates.length < 3) {
        console.log(
          `Skipping activity with insufficient GPS data: ${activity.name}`
        );
        continue;
      }

      // Use first coordinate from polyline for country detection
      const firstCoordinate = coordinates[0];
      const countryDetectionPoint = [firstCoordinate.lat, firstCoordinate.lng];

      const processedActivity = {
        id: activity.id,
        name: activity.name,
        type: activityType,
        distance: (activity.distance / 1000).toFixed(1),
        time: formatDuration(activity.moving_time),
        country: await getCountryFromCoordinates(countryDetectionPoint),
        isRace:
          activity.workout_type === 1 ||
          activity.name.toLowerCase().includes("race"),
        coordinates: coordinates.slice(0, 20), // Limit coordinates for summary view
      };

      activities.push(processedActivity);
    }

    page++;

    // Add a small delay to be nice to Strava's API
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`Fetched ${activities.length} activities total`);
  return activities;
}

// Map Strava activity types to our simplified types
function mapStravaType(stravaType) {
  const typeMap = {
    Run: "run",
    Ride: "ride",
    VirtualRide: null, // Explicitly exclude
    VirtualRun: null, // Explicitly exclude
    Swim: "swim",
    Walk: "run",
    Hike: "run",
    TrailRun: "run",
  };

  return typeMap[stravaType] || null;
}

// Format duration from seconds to HH:MM:SS
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  } else {
    return `${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
}

// Decode Google polyline format
function decodePolyline(encoded) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let byte = 0;
    let shift = 0;
    let result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coordinates.push({
      lat: lat / 1e5,
      lng: lng / 1e5,
    });
  }

  return coordinates;
}

// Accurate country detection using Google Geocoding API with fallback
async function getCountryFromCoordinates(startLatlng) {
  if (!startLatlng || startLatlng.length !== 2) {
    console.log("Invalid coordinates:", startLatlng);
    return "Unknown";
  }

  const [lat, lng] = startLatlng;

  // Try Google Geocoding API first (most accurate)
  try {
    const country = await getCountryFromGoogle(lat, lng);
    if (country && country !== "Unknown") {
      console.log(
        `✅ Google Geocoding: ${lat.toFixed(4)}, ${lng.toFixed(
          4
        )} -> ${country}`
      );
      return country;
    }
  } catch (error) {
    console.warn(
      `Google Geocoding failed for ${lat.toFixed(4)}, ${lng.toFixed(4)}:`,
      error.message
    );
  }

  // Fallback to Nominatim (OpenStreetMap) - Free but rate limited
  try {
    const country = await getCountryFromNominatim(lat, lng);
    if (country && country !== "Unknown") {
      console.log(
        `✅ Nominatim fallback: ${lat.toFixed(4)}, ${lng.toFixed(
          4
        )} -> ${country}`
      );
      return country;
    }
  } catch (error) {
    console.warn(
      `Nominatim failed for ${lat.toFixed(4)}, ${lng.toFixed(4)}:`,
      error.message
    );
  }

  // Final fallback to coordinate ranges
  const fallbackCountry = getCountryFromCoordinateRanges(lat, lng);
  console.log(
    `⚠️ Using coordinate fallback: ${lat.toFixed(4)}, ${lng.toFixed(
      4
    )} -> ${fallbackCountry}`
  );
  return fallbackCountry;
}

// Google Geocoding API
async function getCountryFromGoogle(lat, lng) {
  const GOOGLE_API_KEY =
    process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

  if (!GOOGLE_API_KEY) {
    throw new Error("Google API key not configured");
  }

  // Rate limiting for Google API (to avoid hitting quotas too hard)
  await rateLimitedCall("google", 100); // 100ms between calls

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=country&key=${GOOGLE_API_KEY}`;

  const response = await axios.get(url, { timeout: 10000 });

  if (response.data.status === "OK" && response.data.results.length > 0) {
    const countryComponent = response.data.results[0].address_components.find(
      (component) => component.types.includes("country")
    );

    if (countryComponent) {
      return countryComponent.long_name;
    }
  }

  // Handle specific Google API errors
  if (response.data.status === "OVER_QUERY_LIMIT") {
    throw new Error("Google API quota exceeded");
  } else if (response.data.status === "ZERO_RESULTS") {
    throw new Error("No country found");
  }

  throw new Error(`Google Geocoding failed: ${response.data.status}`);
}

// Nominatim (OpenStreetMap) - Free fallback
async function getCountryFromNominatim(lat, lng) {
  // Rate limiting for Nominatim (required - max 1 request per second)
  await rateLimitedCall("nominatim", 1100); // 1.1 seconds between calls

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=3&addressdetails=1`;

  const response = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "StravaWorldMap/1.0 (strava.activities@example.com)", // Replace with your email
    },
  });

  if (response.data && response.data.address && response.data.address.country) {
    return response.data.address.country;
  }

  throw new Error("Nominatim: No country found");
}

// Rate limiting helper
const lastApiCall = { google: 0, nominatim: 0 };

async function rateLimitedCall(apiName, minIntervalMs) {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCall[apiName];

  if (timeSinceLastCall < minIntervalMs) {
    const waitTime = minIntervalMs - timeSinceLastCall;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  lastApiCall[apiName] = Date.now();
}

// Keep your existing coordinate-based fallback (simplified version)
function getCountryFromCoordinateRanges(lat, lng) {
  // Major regions for fallback
  if (lat >= 35.8 && lat <= 71.2 && lng >= -31.3 && lng <= 69.1) {
    // Europe (broad region)
    if (lat >= 42.3 && lat <= 51.1 && lng >= -5.1 && lng <= 8.2)
      return "France";
    if (lat >= 47.3 && lat <= 55.1 && lng >= 5.9 && lng <= 15.0)
      return "Germany";
    if (lat >= 49.9 && lat <= 60.9 && lng >= -8.2 && lng <= 1.8)
      return "United Kingdom";
    if (lat >= 36.0 && lat <= 47.1 && lng >= 6.6 && lng <= 18.5) return "Italy";
    if (lat >= 35.9 && lat <= 43.8 && lng >= -9.5 && lng <= -6.2)
      return "Spain";
    return "Europe"; // Generic for unknown European countries
  }

  if (lat >= 25.1 && lat <= 49.4 && lng >= -125.0 && lng <= -66.9)
    return "United States";
  if (lat >= 41.7 && lat <= 83.1 && lng >= -141.0 && lng <= -52.6)
    return "Canada";
  if (lat >= 25.6 && lat <= 26.3 && lng >= 50.4 && lng <= 50.8)
    return "Bahrain";
  if (lat >= -47.0 && lat <= -10.0 && lng >= 113.0 && lng <= 154.0)
    return "Australia";

  return "Other";
}

// ========================================
// SERVER STARTUP
// ========================================

// Health check endpoint
app.get("/health", async (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    database: "connected",
    tables: ["strava-activities", "strava-auth"],
  });
});

app.get("/test/geocoding", async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "lat and lng parameters required" });
  }

  try {
    const country = await getCountryFromCoordinates([
      parseFloat(lat),
      parseFloat(lng),
    ]);
    res.json({
      coordinates: { lat: parseFloat(lat), lng: parseFloat(lng) },
      country: country,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Strava Activities Server running on port ${PORT}`);
  console.log(`📍 Strava OAuth URL: http://localhost:${PORT}/auth/strava`);
  console.log(`🏠 Frontend URL: ${FRONTEND_URL}`);
  console.log(`💾 Using DynamoDB for persistent storage`);

  // Validate required environment variables
  if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
    console.warn(
      "⚠️  Warning: Strava credentials not configured. Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env file"
    );
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn(
      "⚠️  Warning: AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env file"
    );
  }
});
