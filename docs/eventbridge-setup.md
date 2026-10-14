# Wiring Amazon Connect to this bridge

No Lambda required. This wires S3 → EventBridge → your running server
directly over HTTPS. Console click-paths below match the console's layout as
of writing, AWS reorganizes console UI periodically, so if a menu name has
moved, search the console for the capitalized term instead of hunting through
menus.

## 1. Turn on Contact Lens and dual-channel recording

Under your Connect instance's flow/recording configuration, enable Contact
Lens for the channels you want (voice, chat, email), and make sure both
Agent and Customer audio tracks are being recorded, Contact Lens's
analytics require both.

## 2. Enable EventBridge notifications on the Connect recording bucket

1. Open the S3 console, find the bucket your Connect instance stores
   recordings and analysis output in (this is the bucket configured under
   your instance's Data storage settings, not necessarily named after the
   instance).
2. **Properties** tab → scroll to **Amazon EventBridge** → **Edit** → turn on
   **Send notifications to Amazon EventBridge for all events in this
   bucket** → **Save**.

This makes every S3 event in that bucket (uploads, not just Contact Lens's)
available to EventBridge rules. The rule in step 4 is what narrows it down.

## 3. Create an EventBridge Connection and API Destination

These two together are what let an EventBridge rule call an arbitrary HTTPS
endpoint with a stored credential, no Lambda in between.

**Connection** (stores the credential EventBridge sends on every call):

1. EventBridge console → **API destinations** → **Connections** →
   **Create connection**.
2. Authorization type: **API key**.
   API key name: the value of `INBOUND_API_KEY_HEADER` (default `x-api-key`).
   Value: the same long random value you set as `INBOUND_API_KEY`.
3. Create.

**API destination**:

1. EventBridge console → **API destinations** → **Create API destination**.
2. API destination endpoint: `https://your-domain/webhook/amazon-connect`
   (wherever you're running this server, it needs a real TLS certificate,
   EventBridge won't call an endpoint with a self-signed one).
3. HTTP method: **POST**.
4. Connection: the one you just created.
5. Invocation rate limit: leave the default unless you expect a very high
   call volume.
6. Create.

## 4. Create the EventBridge rule

1. EventBridge console → **Rules** → **Create rule**, on the bus your S3
   notifications land on (the default event bus, unless you've changed it).
2. Rule type: **Rule with an event pattern**.
3. Event source: **AWS services** → Service: **Simple Storage Service
   (S3)** → Event type: **Amazon S3 Event Notification** → **Object Created**.
4. Specify your bucket name.
5. Switch to the JSON pattern editor and add a prefix filter on the object
   key so the rule only fires for Contact Lens output, not every recording
   upload:

   ```json
   {
     "source": ["aws.s3"],
     "detail-type": ["Object Created"],
     "detail": {
       "bucket": { "name": ["your-connect-bucket"] },
       "object": { "key": [{ "prefix": "Analysis/" }] }
     }
   }
   ```

   Note: this prefix must match the start of the real key. In the one test bucket checked, analysis files were at the top of the bucket, for example `Analysis/Chat/2026/10/14/<contactId>_analysis_<time>.json`. The rule above uses the shorter `Analysis/` so it covers voice and chat; the app itself narrows it with `AMAZON_CONNECT_ANALYSIS_PATH_PREFIX`. If your bucket differs, use the real start of the key. The rule itself has not been run against a real event.

   (This app also checks `AMAZON_CONNECT_ANALYSIS_PATH_PREFIX` itself before doing anything,
   so a looser rule pattern here is a minor cost, not a correctness problem,
   but a tighter pattern means less noise in your logs.)

6. Target: **EventBridge API destination** → select the one from step 3.
7. When prompted, let EventBridge create the IAM role it needs to invoke the
   API destination on your behalf, that role is for EventBridge calling out
   to your endpoint, unrelated to the IAM credential this server itself uses
   to read S3 (next section).
8. Create rule.

## 5. IAM policy for the server itself

Separate from everything above: the running server needs its own AWS
credentials (or an instance/task role, if it's running on EC2/ECS/similar)
to actually fetch the analysis JSON, and the CTR object if you're using the
`s3` CTR resolver. Minimum policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::your-connect-bucket/Analysis/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::your-connect-bucket"
    }
  ]
}
```

`s3:ListBucket` is there so that a missing file is reported as not found instead of access denied.

Add a second resource ARN covering your `AMAZON_CONNECT_CTR_S3_PREFIX` if you're using
`AMAZON_CONNECT_CTR_RESOLVER=s3`.

## 6. Test it

Make a test call through your Connect instance with Contact Lens enabled,
let it complete, and give Contact Lens a minute or two to finish analyzing
it. Then check this server's logs, you should see a line like:

```json
{"level":"info","msg":"Forwarded normalized conversation","contactId":"...","attempt":1,"status":200}
```

If nothing shows up, check in this order: the S3 bucket actually has a new
object under `Analysis/` (confirms Contact Lens itself is working),
the EventBridge rule's metrics show an invocation (confirms the S3→
EventBridge→rule path), and the API destination's CloudWatch metrics show a
successful call (confirms the connection/auth is right). Each of those three
narrows down which link in the chain to look at.
