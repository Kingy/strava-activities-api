// dynamodb.js - DynamoDB configuration and operations (AWS SDK v3)
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const getDynamoDBClient = () => {
  console.log("Configuring DynamoDB client...");
  console.log("Region:", process.env.AWS_REGION || "us-east-1");

  // For Lambda, use IAM role credentials (no explicit credentials needed)
  // For local development, use environment variables if available
  const clientConfig = {
    region: process.env.AWS_REGION || "us-east-1",
  };

  // Only add explicit credentials if running locally (not in Lambda)
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  ) {
    console.log("Using explicit credentials for local development");
    clientConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
    };
  } else if (process.env.NODE_ENV === "production") {
    console.log("Using IAM role credentials for Lambda");
  }

  const client = new DynamoDBClient(clientConfig);
  return DynamoDBDocumentClient.from(client);
};

const dynamodb = getDynamoDBClient();

// Table names
const ACTIVITIES_TABLE =
  process.env.DYNAMODB_ACTIVITIES_TABLE || "strava-activities";
const AUTH_TABLE = process.env.DYNAMODB_AUTH_TABLE || "strava-auth";

// ========================================
// AUTH TOKEN OPERATIONS
// ========================================

// Store/update authentication tokens
async function storeAuthToken(athleteId, tokenData) {
  const command = new PutCommand({
    TableName: AUTH_TABLE,
    Item: {
      athlete_id: athleteId.toString(),
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      athlete_info: tokenData.athlete_info,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });

  try {
    await dynamodb.send(command);
    console.log(`Stored auth token for athlete: ${athleteId}`);
    return true;
  } catch (error) {
    console.error("Error storing auth token:", error);
    throw error;
  }
}

// Get authentication tokens
async function getAuthToken(athleteId) {
  const command = new GetCommand({
    TableName: AUTH_TABLE,
    Key: {
      athlete_id: athleteId.toString(),
    },
  });

  try {
    const result = await dynamodb.send(command);
    return result.Item || null;
  } catch (error) {
    console.error("Error getting auth token:", error);
    throw error;
  }
}

// Refresh access token using refresh token
async function refreshAccessToken(athleteId, refreshToken) {
  const axios = require("axios");

  try {
    console.log(`Refreshing access token for athlete: ${athleteId}`);

    const response = await axios.post("https://www.strava.com/oauth/token", {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const tokenData = response.data;

    // Store the refreshed token
    await storeAuthToken(athleteId, tokenData);

    console.log(`Successfully refreshed token for athlete: ${athleteId}`);
    return tokenData;
  } catch (error) {
    console.error("Error refreshing access token:", error);
    throw error;
  }
}

// Get valid access token (refresh if expired)
async function getValidAccessToken(athleteId) {
  const authData = await getAuthToken(athleteId);

  if (!authData) {
    throw new Error("No authentication data found");
  }

  // Check if token is expired (with 5 minute buffer)
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = authData.expires_at;

  if (expiresAt && now + 300 >= expiresAt) {
    console.log("Access token expired, refreshing...");
    const refreshedTokens = await refreshAccessToken(
      athleteId,
      authData.refresh_token
    );
    return refreshedTokens.access_token;
  }

  return authData.access_token;
}

// ========================================
// ACTIVITY OPERATIONS
// ========================================

// Store a single activity
async function storeActivity(activity) {
  const command = new PutCommand({
    TableName: ACTIVITIES_TABLE,
    Item: {
      ...activity,
      stored_at: new Date().toISOString(),
    },
  });

  try {
    await dynamodb.send(command);
    return true;
  } catch (error) {
    console.error("Error storing activity:", error);
    throw error;
  }
}

// Store multiple activities (batch operation)
async function storeActivities(activities) {
  const batchSize = 25; // DynamoDB batch limit
  const batches = [];

  for (let i = 0; i < activities.length; i += batchSize) {
    batches.push(activities.slice(i, i + batchSize));
  }

  let totalStored = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const command = new BatchWriteCommand({
      RequestItems: {
        [ACTIVITIES_TABLE]: batch.map((activity) => ({
          PutRequest: {
            Item: {
              ...activity,
              stored_at: new Date().toISOString(),
            },
          },
        })),
      },
    });

    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount <= maxRetries) {
      try {
        await dynamodb.send(command);
        totalStored += batch.length;
        console.log(
          `Stored batch ${i + 1}/${batches.length} (${
            batch.length
          } activities) - Total: ${totalStored}/${activities.length}`
        );

        // Longer delay to avoid throttling, especially for large batches
        const delayMs = activities.length > 500 ? 1000 : 500; // 1 second for large syncs
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        break; // Success, exit retry loop
      } catch (error) {
        if (
          error.name === "ProvisionedThroughputExceededException" &&
          retryCount < maxRetries
        ) {
          retryCount++;
          const backoffDelay = Math.pow(2, retryCount) * 1000; // Exponential backoff
          console.log(
            `Throughput exceeded, retrying batch ${
              i + 1
            } in ${backoffDelay}ms (attempt ${retryCount}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        } else {
          console.error("Error storing activity batch:", error);
          throw error;
        }
      }
    }
  }

  console.log(`Successfully stored ${totalStored} activities`);
  return totalStored;
}

// Get activities for an athlete with filtering
async function getActivities(athleteId, filters = {}) {
  const command = new QueryCommand({
    TableName: ACTIVITIES_TABLE,
    IndexName: "athlete-index",
    KeyConditionExpression: "athlete_id = :athlete_id",
    ExpressionAttributeValues: {
      ":athlete_id": athleteId.toString(),
    },
  });

  // Add filters
  if (filters.activity_type && filters.activity_type !== "all") {
    command.input.FilterExpression = "#type = :type";
    command.input.ExpressionAttributeNames = { "#type": "type" };
    command.input.ExpressionAttributeValues[":type"] = filters.activity_type;
  }

  if (filters.race_filter && filters.race_filter !== "all") {
    const raceCondition = "isRace = :isRace";
    const raceValue = filters.race_filter === "race";

    if (command.input.FilterExpression) {
      command.input.FilterExpression += ` AND ${raceCondition}`;
    } else {
      command.input.FilterExpression = raceCondition;
    }
    command.input.ExpressionAttributeValues[":isRace"] = raceValue;
  }

  try {
    const result = await dynamodb.send(command);
    return result.Items || [];
  } catch (error) {
    console.error("Error getting activities:", error);
    throw error;
  }
}

// Get a specific activity by ID
async function getActivity(activityId) {
  const command = new GetCommand({
    TableName: ACTIVITIES_TABLE,
    Key: {
      id: parseInt(activityId),
    },
  });

  try {
    const result = await dynamodb.send(command);
    return result.Item || null;
  } catch (error) {
    console.error("Error getting activity:", error);
    throw error;
  }
}

// Check if activity exists (to avoid duplicates)
async function activityExists(activityId) {
  const command = new GetCommand({
    TableName: ACTIVITIES_TABLE,
    Key: {
      id: parseInt(activityId),
    },
    ProjectionExpression: "id",
  });

  try {
    const result = await dynamodb.send(command);
    return !!result.Item;
  } catch (error) {
    console.error("Error checking activity existence:", error);
    return false;
  }
}

// Get activity count for an athlete
async function getActivityCount(athleteId) {
  const command = new QueryCommand({
    TableName: ACTIVITIES_TABLE,
    IndexName: "athlete-index",
    KeyConditionExpression: "athlete_id = :athlete_id",
    ExpressionAttributeValues: {
      ":athlete_id": athleteId.toString(),
    },
    Select: "COUNT",
  });

  try {
    const result = await dynamodb.send(command);
    return result.Count || 0;
  } catch (error) {
    console.error("Error getting activity count:", error);
    return 0;
  }
}

// Delete all activities for an athlete (for fresh sync)
async function deleteAllActivities(athleteId) {
  const activities = await getActivities(athleteId);

  if (activities.length === 0) {
    return 0;
  }

  const batchSize = 25;
  const batches = [];

  for (let i = 0; i < activities.length; i += batchSize) {
    batches.push(activities.slice(i, i + batchSize));
  }

  let totalDeleted = 0;

  for (const batch of batches) {
    const command = new BatchWriteCommand({
      RequestItems: {
        [ACTIVITIES_TABLE]: batch.map((activity) => ({
          DeleteRequest: {
            Key: { id: activity.id },
          },
        })),
      },
    });

    try {
      await dynamodb.send(command);
      totalDeleted += batch.length;
      console.log(
        `Deleted batch of ${batch.length} activities (${totalDeleted}/${activities.length})`
      );
    } catch (error) {
      console.error("Error deleting activity batch:", error);
      throw error;
    }
  }

  console.log(`Successfully deleted ${totalDeleted} activities`);
  return totalDeleted;
}

module.exports = {
  // Auth operations
  storeAuthToken,
  getAuthToken,
  refreshAccessToken,
  getValidAccessToken,

  // Activity operations
  storeActivity,
  storeActivities,
  getActivities,
  getActivity,
  activityExists,
  getActivityCount,
  deleteAllActivities,
};
