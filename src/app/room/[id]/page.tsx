import RoomRouteClient from "./roomRouteClient";

export const dynamicParams = false;
export function generateStaticParams() { return [{ id: "placeholder" }]; }
export default function RoomPage() { return <RoomRouteClient />; }