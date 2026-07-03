import { APIGatewayProxyHandler } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'

const isOffline = process.env.IS_OFFLINE === 'true'

const dbClient = isOffline
  ? new DynamoDBClient({
      endpoint: 'http://localhost:8000',
      region: 'localhost',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local'
      }
    })
  : new DynamoDBClient({})

const docClient = DynamoDBDocumentClient.from(dbClient)

const s3Client = isOffline
  ? new S3Client({
      endpoint: 'http://localhost:4569',
      region: 'localhost',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local'
      },
      forcePathStyle: true
    })
  : new S3Client({})

const sesClient = isOffline
  ? new SESClient({
      endpoint: 'http://localhost:4565',
      region: 'localhost',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local'
      }
    })
  : new SESClient({})

const tableName = process.env.DYNAMODB_TABLE || 'jobnet-jobs-dev'
const bucketName = process.env.S3_UPLOAD_BUCKET || 'jobnet-uploads-dev'

export const getJobs: APIGatewayProxyHandler = async (event) => {
  try {
    const result = await docClient.send(new ScanCommand({ TableName: tableName }))
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify(result.Items || [])
    }
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify({ error: error.message })
    }
  }
}

export const createJob: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}')
    const item = {
      id: Math.random().toString(36).substring(2),
      title: body.title,
      company: body.company,
      lat: body.lat,
      lng: body.lng,
      createdAt: new Date().toISOString()
    }
    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: item
    }))
    return {
      statusCode: 201,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify(item)
    }
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify({ error: error.message })
    }
  }
}

export const getUploadPresignedUrl: APIGatewayProxyHandler = async (event) => {
  try {
    const key = `uploads/${Date.now()}-${Math.random().toString(36).substring(2)}`
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key
    })
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 })
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify({ url, key })
    }
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify({ error: error.message })
    }
  }
}

export const sendNotificationEmail: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}')
    const { to, subject, message } = body
    await sesClient.send(new SendEmailCommand({
      Source: 'noreply@jobnet-platform.com',
      Destination: {
        ToAddresses: [to]
      },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: message } }
      }
    }))
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify({ success: true })
    }
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true
      },
      body: JSON.stringify({ error: error.message })
    }
  }
}
