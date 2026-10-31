import { redirect } from "next/navigation";
export default async function Arena({searchParams}: {searchParams: Promise<{room?: string}>}) {
  const {room} = await searchParams;
  redirect(room ? "/arena.html?room=" + encodeURIComponent(room) : "/arena.html");
}
