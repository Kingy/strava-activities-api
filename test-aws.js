require("dotenv").config();
const {
  DynamoDBClient,
  ListTablesCommand,
} = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function testConnection() {
  console.log("Testing AWS connection...");
  console.log("Region:", process.env.AWS_REGION);
  console.log(
    "Access Key ID:",
    process.env.AWS_ACCESS_KEY_ID ? "Set" : "Missing"
  );
  console.log(
    "Secret Key:",
    process.env.AWS_SECRET_ACCESS_KEY ? "Set" : "Missing"
  );

  try {
    const command = new ListTablesCommand({});
    const response = await client.send(command);
    console.log("✅ AWS connection successful!");
    console.log("Tables found:", response.TableNames);
  } catch (error) {
    console.error("❌ AWS connection failed:", error.message);
  }
}

testConnection();
