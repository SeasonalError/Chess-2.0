import type {Metadata} from "next";
export const metadata: Metadata = {
  title: "Riftbound · Chess 2.0",
  description: "An anime chess arena with limited-use techniques, bot battles and invite rooms.",
  icons: {icon: "/favicon.svg"},
};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
