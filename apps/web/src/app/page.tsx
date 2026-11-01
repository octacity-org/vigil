import { redirect } from "next/navigation";

/** The finding list is the start page (#81). */
export default function Home() {
  redirect("/bulgular");
}
