// scripts/create-tables.js - Script to create DynamoDB tables (AWS SDK v3)
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
require('dotenv').config();

// Configure AWS
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

async function createTables() {
  console.log('Creating DynamoDB tables...');

  // Activities Table
  const activitiesTableParams = {
    TableName: 'strava-activities',
    KeySchema: [
      {
        AttributeName: 'id',
        KeyType: 'HASH' // Partition key (Strava activity ID)
      }
    ],
    AttributeDefinitions: [
      {
        AttributeName: 'id',
        AttributeType: 'N' // Number
      },
      {
        AttributeName: 'athlete_id',
        AttributeType: 'S' // String
      }
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'athlete-index',
        KeySchema: [
          {
            AttributeName: 'athlete_id',
            KeyType: 'HASH'
          }
        ],
        Projection: {
          ProjectionType: 'ALL'
        },
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5
        }
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5
    }
  };

  // Auth Table
  const authTableParams = {
    TableName: 'strava-auth',
    KeySchema: [
      {
        AttributeName: 'athlete_id',
        KeyType: 'HASH' // Partition key
      }
    ],
    AttributeDefinitions: [
      {
        AttributeName: 'athlete_id',
        AttributeType: 'S' // String
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 2,
      WriteCapacityUnits: 2
    }
  };

  try {
    // Create Activities table
    console.log('Creating activities table...');
    await client.send(new CreateTableCommand(activitiesTableParams));
    console.log('✅ Activities table created successfully');

    // Create Auth table
    console.log('Creating auth table...');
    await client.send(new CreateTableCommand(authTableParams));
    console.log('✅ Auth table created successfully');

    console.log('Waiting for tables to be active...');
    
    // Wait for tables to be active
    await waitUntilTableExists({ client, maxWaitTime: 300 }, { TableName: 'strava-activities' });
    await waitUntilTableExists({ client, maxWaitTime: 300 }, { TableName: 'strava-auth' });
    
    console.log('🎉 All tables are ready!');
    
    // Display table info
    const activitiesDesc = await client.send(new DescribeTableCommand({ TableName: 'strava-activities' }));
    const authDesc = await client.send(new DescribeTableCommand({ TableName: 'strava-auth' }));
    
    console.log('\n📊 Table Information:');
    console.log(`Activities Table: ${activitiesDesc.Table.TableStatus}`);
    console.log(`Auth Table: ${authDesc.Table.TableStatus}`);
    console.log(`\nEstimated monthly cost (light usage): ~$1-5 USD`);
    
  } catch (error) {
    if (error.name === 'ResourceInUseException') {
      console.log('⚠️  Tables already exist, checking status...');
      
      try {
        const activitiesDesc = await client.send(new DescribeTableCommand({ TableName: 'strava-activities' }));
        const authDesc = await client.send(new DescribeTableCommand({ TableName: 'strava-auth' }));
        console.log(`Activities Table: ${activitiesDesc.Table.TableStatus}`);
        console.log(`Auth Table: ${authDesc.Table.TableStatus}`);
      } catch (descError) {
        console.error('Error checking table status:', descError);
      }
    } else {
      console.error('Error creating tables:', error);
      process.exit(1);
    }
  }
}

// Check AWS credentials
function checkCredentials() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('❌ AWS credentials not found!');
    console.log('Please set the following environment variables:');
    console.log('- AWS_ACCESS_KEY_ID');
    console.log('- AWS_SECRET_ACCESS_KEY');
    console.log('- AWS_REGION (optional, defaults to us-east-1)');
    process.exit(1);
  }
  
  console.log('✅ AWS credentials found');
  console.log(`Region: ${process.env.AWS_REGION || 'us-east-1'}`);
}

// Run the script
if (require.main === module) {
  checkCredentials();
  createTables().then(() => {
    console.log('Script completed successfully!');
    process.exit(0);
  }).catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

module.exports = { createTables };
        const authDesc = await dynamodb.describeTable({ TableName: 'strava-auth' }).promise();
        console.log(`Activities Table: ${activitiesDesc.Table.TableStatus}`);
        console.log(`Auth Table: ${authDesc.Table.TableStatus}`);
      } catch (descError) {
        console.error('Error checking table status:', descError);
      }
    } else {
      console.error('Error creating tables:', error);
      process.exit(1);
    }
  }
}

// Check AWS credentials
function checkCredentials() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('❌ AWS credentials not found!');
    console.log('Please set the following environment variables:');
    console.log('- AWS_ACCESS_KEY_ID');
    console.log('- AWS_SECRET_ACCESS_KEY');
    console.log('- AWS_REGION (optional, defaults to us-east-1)');
    process.exit(1);
  }
  
  console.log('✅ AWS credentials found');
  console.log(`Region: ${process.env.AWS_REGION || 'us-east-1'}`);
}

// Run the script
if (require.main === module) {
  checkCredentials();
  createTables().then(() => {
    console.log('Script completed successfully!');
    process.exit(0);
  }).catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

module.exports = { createTables };