const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Configure AWS
const s3 = new AWS.S3();
const cloudfront = new AWS.CloudFront();

const BUCKET_NAME = "strava-activities-frontend";
const DISTRIBUTION_ID = "your-cloudfront-distribution-id";

async function deployFrontend() {
  console.log("🏗️  Building React app...");

  // Build the React app
  execSync("npm run build", { cwd: "../frontend", stdio: "inherit" });

  console.log("📦 Uploading to S3...");

  // Upload build files to S3
  const buildDir = path.join(__dirname, "../frontend/build");
  await uploadDirectory(buildDir, "");

  console.log("🔄 Invalidating CloudFront cache...");

  // Invalidate CloudFront cache
  await cloudfront
    .createInvalidation({
      DistributionId: DISTRIBUTION_ID,
      InvalidationBatch: {
        CallerReference: Date.now().toString(),
        Paths: {
          Quantity: 1,
          Items: ["/*"],
        },
      },
    })
    .promise();

  console.log("✅ Frontend deployment complete!");
}

async function uploadDirectory(localDir, s3Prefix) {
  const files = fs.readdirSync(localDir);

  for (const file of files) {
    const filePath = path.join(localDir, file);
    const s3Key = s3Prefix ? `${s3Prefix}/${file}` : file;

    if (fs.statSync(filePath).isDirectory()) {
      await uploadDirectory(filePath, s3Key);
    } else {
      const contentType = getContentType(file);

      await s3
        .upload({
          Bucket: BUCKET_NAME,
          Key: s3Key,
          Body: fs.readFileSync(filePath),
          ContentType: contentType,
          CacheControl: file.includes(".html")
            ? "no-cache"
            : "max-age=31536000",
        })
        .promise();

      console.log(`   Uploaded: ${s3Key}`);
    }
  }
}

function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const contentTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return contentTypes[ext] || "application/octet-stream";
}

if (require.main === module) {
  deployFrontend().catch(console.error);
}
