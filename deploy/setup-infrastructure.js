const AWS = require("aws-sdk");

const s3 = new AWS.S3();
const cloudfront = new AWS.CloudFront();

async function setupInfrastructure() {
  console.log("🏗️  Setting up AWS infrastructure...");

  // Create S3 bucket for frontend
  try {
    await s3
      .createBucket({
        Bucket: BUCKET_NAME,
        ACL: "public-read",
      })
      .promise();

    // Configure bucket for static website hosting
    await s3
      .putBucketWebsite({
        Bucket: BUCKET_NAME,
        WebsiteConfiguration: {
          IndexDocument: { Suffix: "index.html" },
          ErrorDocument: { Key: "index.html" },
        },
      })
      .promise();

    console.log("✅ S3 bucket created and configured");
  } catch (error) {
    if (error.code === "BucketAlreadyOwnedByYou") {
      console.log("✅ S3 bucket already exists");
    } else {
      throw error;
    }
  }

  // Create CloudFront distribution
  try {
    const distributionConfig = {
      CallerReference: Date.now().toString(),
      DefaultCacheBehavior: {
        TargetOriginId: "S3-strava-activities",
        ViewerProtocolPolicy: "redirect-to-https",
        TrustedSigners: {
          Enabled: false,
          Quantity: 0,
        },
        ForwardedValues: {
          QueryString: false,
          Cookies: { Forward: "none" },
        },
        MinTTL: 0,
      },
      Origins: {
        Quantity: 1,
        Items: [
          {
            Id: "S3-strava-activities",
            DomainName: `${BUCKET_NAME}.s3.amazonaws.com`,
            S3OriginConfig: {
              OriginAccessIdentity: "",
            },
          },
        ],
      },
      Comment: "Strava Activities Frontend Distribution",
      Enabled: true,
    };

    const result = await cloudfront
      .createDistribution({
        DistributionConfig: distributionConfig,
      })
      .promise();

    console.log("✅ CloudFront distribution created");
    console.log(`   Domain: ${result.Distribution.DomainName}`);
  } catch (error) {
    console.warn("CloudFront setup failed (may already exist):", error.message);
  }

  console.log("🎉 Infrastructure setup complete!");
}

if (require.main === module) {
  setupInfrastructure().catch(console.error);
}
