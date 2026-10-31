import { getDb } from "../db";
import { handleRoomRequest } from "./rooms.js";

export function roomRoute(request: Request) {
  return handleRoomRequest(getDb().$client, request);
}
