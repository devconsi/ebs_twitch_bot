import axios from "axios";
import WebSocket from "ws";
import dotenv from "dotenv";
import http from "http";
import https from "https";
import cors from "cors";
import express from "express";
import crypto from "crypto";
import fs from "fs";

dotenv.config();
const APP_PORT = 8080;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const DEPLOYED = process.env.DEPLOYED;
const EVENT_SUB_SECRET = process.env.EVENT_SUB_SECRET; //For EventSub

// Notification request headers
const TWITCH_MESSAGE_ID = "Twitch-Eventsub-Message-Id".toLowerCase();
const TWITCH_MESSAGE_TIMESTAMP =
  "Twitch-Eventsub-Message-Timestamp".toLowerCase();
const TWITCH_MESSAGE_SIGNATURE =
  "Twitch-Eventsub-Message-Signature".toLowerCase();
const MESSAGE_TYPE = "Twitch-Eventsub-Message-Type".toLowerCase();

// Notification message types
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

const app = express();

// Prepend this string to the HMAC that's created from the message
const HMAC_PREFIX = "sha256=";

app.use(
  express.raw({
    // Need raw message body for signature verification
    type: "application/json",
  })
);

const whitelist = ["https://"]; //TODO
if (!DEPLOYED) {
  whitelist.push("https://fe-twitch-super-cool-site.netlify.app");
  whitelist.push("https://fe-twitch-super-cool-site.netlify.app"); //only to test locally
}

var corsOptions = {
  origin: "https://fe-twitch-super-cool-site.netlify.app",
  //origin: "https://fe-twitch-super-cool-site.netlify.app",
  // origin: function (origin, callback) {
  //   console.log(`evaluate ticket whitelist $(whitelist.indexOf(origin) !== -1)`)
  //   console.log(whitelist.indexOf(origin) !== -1)
  //   console.log(whitelist)
  //   console.log(origin)
  //   if (whitelist.indexOf(origin) !== -1) {
  //     callback(null, true)
  //   } else {
  //     callback(new Error('Not allowed by CORS'))
  //   }
  // }
};

//app.use(cors(corsOptions)); //Old wayw ith cors on use
let server;
console.log(DEPLOYED);
console.log(whitelist);
if (DEPLOYED) {
  const privateKey = fs.readFileSync("/TODO/privkey.pem"); //TODO certs keys
  const certificate = fs.readFileSync("/TODO/fullchain.pem");

  const credentials = { key: privateKey, cert: certificate };
  server = https.createServer(credentials, app);
  server.listen(443);
  console.log(`Listening on port  443`);
} else {
  // const __dirname = "/git/animated-twitch-chat-bot/api"
  // const privateKey = fs.readFileSync(path.join(__dirname, 'key.pem'));
  // const certificate = fs.readFileSync(path.join(__dirname, 'cert.pem'));

  //   const credentials = {key: privateKey, cert: certificate};
  server = http.createServer(app);
  server.listen(APP_PORT);
  console.log(`Listening on port  ${APP_PORT}`);
}

app.get("/ticket", cors(corsOptions), (req, res) => {
  const origin = req.get("origin");
  const ticket = generateTicket(origin);
  res.send({ ticket: ticket });
});

app.post("/callback", (req, res) => {
  let secret = getSecret();
  let message = getHmacMessage(req);
  let hmac = HMAC_PREFIX + getHmac(secret, message); // Signature to compare

  if (true === verifyMessage(hmac, req.headers[TWITCH_MESSAGE_SIGNATURE])) {
    console.log("TWITCH:signatures match");

    // Get JSON object from body, so you can process the message.
    let notification = JSON.parse(req.body);

    if (MESSAGE_TYPE_NOTIFICATION === req.headers[MESSAGE_TYPE]) {
      //TODO Correctl;y handle requests
      blastMessage(PONG, { username: "CALLBACK" });

      console.log(`Event type: ${notification.subscription.type}`);
      console.log(JSON.stringify(notification.event, null, 4));

      res.sendStatus(204);
    } else if (MESSAGE_TYPE_VERIFICATION === req.headers[MESSAGE_TYPE]) {
      res.status(200).send(notification.challenge);
    } else if (MESSAGE_TYPE_REVOCATION === req.headers[MESSAGE_TYPE]) {
      res.sendStatus(204);

      console.log(`${notification.subscription.type} notifications revoked!`);
      console.log(`reason: ${notification.subscription.status}`);
      console.log(
        `condition: ${JSON.stringify(
          notification.subscription.condition,
          null,
          4
        )}`
      );
    } else {
      res.sendStatus(204);
      console.log(`Unknown message type: ${req.headers[MESSAGE_TYPE]}`);
    }
  } else {
    console.log("403"); // Signatures didn't match.
    res.sendStatus(403);
  }
});

//------------ Fucntions to validate twitch HMAC ------------------------------

function getSecret() {
  //Get secret from secure storage. This is the secret you pass
  // when you subscribed to the event.
  return EVENT_SUB_SECRET;
}

// Build the message used to get the HMAC.
function getHmacMessage(request) {
  return (
    request.headers[TWITCH_MESSAGE_ID] +
    request.headers[TWITCH_MESSAGE_TIMESTAMP] +
    request.body
  );
}

// Get the HMAC.
function getHmac(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// Verify whether our hash matches the hash that Twitch passed in the header.
function verifyMessage(hmac, verifySignature) {
  return crypto.timingSafeEqual(
    Buffer.from(hmac),
    Buffer.from(verifySignature)
  );
}

//------------ Ticket and Websocket to FE validation ---------------------------

//initialize the WebSocket server instance, for connecting to FrontEnd Connections
const wss = new WebSocket.Server({ server: server });

const currentConnections = [];
const activeTickets = {};
const TICKET_EXPIRATION = 60 * 1000;
const CHAT_COMMAND = "CHAT_COMMAND";
const POINTS_REDEMPTION = "POINTS_REDEMPTION";
const PONG = "PONG";

wss.on("connection", (ws, request) => {
  const origin = getOriginFromHeaders(request.rawHeaders);
  if (whitelist.indexOf(origin) == -1) {
    console.log(`whitelist does not contain origin ${origin}`);
    ws.close();
    return;
  }
  if (!validateTicket(request.url, origin)) {
    console.log(`invalid ticket ${request.url} ${origin}`);
    ws.close();
    return;
  }
  console.log(`valid ticket found ${request.url}`);
  currentConnections.push(ws);

  ws.on("message", (messageAsByte) => {
    const message = JSON.parse(messageAsByte.toString());
    //Send a response if PING
    if (message.message === "ping") {
      ws.send(JSON.stringify({ type: PONG, message: { action: "PONG" } }));
    } else {
      //Ignore messages that are not ping
    }
  });
});

function getOriginFromHeaders(headers) {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === "origin") {
      return headers[i + 1];
    }
  }
  return null;
}

function validateTicket(url, origin) {
  const index = url.indexOf("ticket=");
  const submittedTicket = url.substring(index + 7);
  let foundTicket;
  for (let ticket in activeTickets) {
    if (
      ticket === submittedTicket &&
      activeTickets[ticket].origin === origin &&
      activeTickets[ticket].expiration > Date.now()
    ) {
      foundTicket = ticket;
      break;
    }
  }
  if (foundTicket) {
    delete activeTickets[foundTicket];
    return true;
  }
  return false;
}

function generateTicket(origin) {
  const ticket = crypto.randomBytes(20).toString("hex");
  activeTickets[ticket] = {
    origin: origin,
    expiration: Date.now() + TICKET_EXPIRATION,
  };
  return ticket;
}

const ticketCleanup = setInterval(() => {
  const expiredTickets = [];
  Object.keys(activeTickets).forEach((ticket) => {
    if (activeTickets[ticket].expiration > Date.now()) {
      expiredTickets.push(ticket);
    }
  });
  expiredTickets.forEach((ticket) => delete activeTickets[ticket]);
}, 1000);

//-----------------Process Events functions --------------------------

const messageTypeToProcessor = {
  "channel-points-channel-v1": processChannelPoints,
  //TODO Add follow/subs etc...
};

function processChannelPoints(data) {
  const redemptionType = data.data.redemption.reward.title;
  const name = data.data.redemption.user.display_name;
  switch (redemptionType) {
    case "Highlight My Message":
      console.log("got a highlight my message event");
      break;
    default:
      console.log(`got this reward ${redemptionType}`);
      blastMessage(POINTS_REDEMPTION, {
        username: name,
        command: redemptionType,
      });
  }
}

function blastMessage(type, message) {
  currentConnections.forEach((ws) =>
    ws.send(JSON.stringify({ type: type, message: message }))
  );
}
