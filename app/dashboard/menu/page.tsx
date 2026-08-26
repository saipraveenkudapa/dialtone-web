import { MenuEditor } from "@/components/MenuEditor";
import { MenuUpload } from "@/components/MenuUpload";
import { getCurrentLocation, getMenuImports } from "@/lib/data";

export const metadata = { title: "Menu · Dialtone" };

export default async function Page() {
  const location = await getCurrentLocation();

  // The layout above this already refuses an account with no restaurant,
  // so this branch is only here to keep the editor renderable if that
  // ever stops being true.
  if (!location) return <MenuEditor />;

  const imports = await getMenuImports(location.id);

  return (
    <>
      <MenuEditor />
      {/* Below the menu on purpose: typing an item is the everyday job,
          importing one is the day-one job. */}
      <MenuUpload
        locationId={location.id}
        timezone={location.timezone}
        initialImports={imports}
      />
    </>
  );
}
