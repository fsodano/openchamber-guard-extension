/**
 * Draws the panel frame: the header, the connection notice, and the slot the
 * guard view draws in. All values go in as text (`textContent`), never as HTML.
 * Everything is mounted once, so focus inside the guard view survives header updates.
 */
import { mountBadge, mountEmpty, type BadgeHandle, type EmptyHandle } from "@openchamber/sdk/ui"

export type NoHostReason = "not-embedded" | "no-answer" | "closed"

export type View = {
  /** The guard view draws inside this element. */
  guardsRoot: HTMLElement
  /** `undefined` while connecting, `null` when no project is open. */
  setPlace: (directory: string | null | undefined) => void
  /** Number of guards active in this session, shown as a header badge. */
  setActiveCount: (count: number) => void
  /** OpenChamber did not connect. Hides the guard view and says what to do. */
  noHost: (reason: NoHostReason) => void
  /** OpenChamber answered, possibly after a no-host notice. Shows the guard view again. */
  connected: () => void
  dispose: () => void
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SVG = "http://www.w3.org/2000/svg"

/** The extension's shield mark, drawn in the theme's text color. */
const shield = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("class", "hdr-mark")
  for (const d of ["M12 2.75 4.75 5.6v5.65c0 4.55 3.05 8.35 7.25 9.95 4.2-1.6 7.25-5.4 7.25-9.95V5.6z", "M8.75 12h6.5"]) {
    const path = document.createElementNS(SVG, "path")
    path.setAttribute("d", d)
    svg.append(path)
  }
  return svg
}

const basename = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const NO_HOST: Record<NoHostReason, { title: string; body: string }> = {
  "not-embedded": { title: "Open this panel in OpenChamber", body: "Add this folder in OpenChamber under Settings → Extensions." },
  "no-answer": { title: "OpenChamber did not connect", body: "Close this panel and open it again." },
  closed: { title: "Panel closed", body: "Open the panel again to manage guards." },
}

export const createView = (options: { root: HTMLElement }): View => {
  const { root } = options
  root.replaceChildren()

  const header = h("header", "hdr")
  const headerText = h("div", "hdr-text")
  const title = h("h1", "hdr-title")
  title.append(shield(), h("span", "", "Guards"))
  const place = h("p", "hdr-place")
  const placeLabel = h("span", "hdr-label", "Project")
  const placeName = h("span", "hdr-name", "Connecting to OpenChamber…")
  // A space between label and value, so the text reads "Project name" to screen readers and in copies.
  place.append(placeLabel, " ", placeName)
  placeLabel.hidden = true
  const placePath = h("p", "hdr-path")
  placePath.hidden = true
  headerText.append(title, place, placePath)
  const badgeSlot = h("div", "hdr-badge")
  header.append(headerText, badgeSlot)

  const notice = h("div", "slot")
  notice.hidden = true

  const guardsRoot = h("div", "gd-root")
  guardsRoot.id = "guards"

  root.append(header, notice, guardsRoot)

  let badge: BadgeHandle | null = null
  let empty: EmptyHandle | null = null
  let count = 0

  const setPlace = (directory: string | null | undefined) => {
    if (directory === undefined) {
      placeLabel.hidden = true
      placeName.textContent = "Connecting to OpenChamber…"
      placePath.hidden = true
      return
    }
    if (directory === null) {
      placeLabel.hidden = true
      placeName.textContent = "No project open"
      placePath.textContent = "Sessions without a project"
      placePath.title = ""
    } else {
      placeLabel.hidden = false
      placeName.textContent = basename(directory)
      placePath.textContent = directory
      placePath.title = directory
    }
    placePath.hidden = false
  }

  const setActiveCount = (next: number) => {
    if (next === count) return
    count = next
    if (count === 0) {
      badge?.dispose()
      badge = null
      return
    }
    const label = `${count} active`
    if (badge) badge.update({ label, tone: "primary" })
    else badge = mountBadge(badgeSlot, { label, tone: "primary" })
  }

  const noHost = (reason: NoHostReason) => {
    placeLabel.hidden = true
    placeName.textContent = "Not connected"
    placePath.hidden = true
    guardsRoot.hidden = true
    notice.hidden = false
    const props = NO_HOST[reason]
    if (empty) empty.update(props)
    else empty = mountEmpty(notice, props)
  }

  const connected = () => {
    notice.hidden = true
    guardsRoot.hidden = false
  }

  return {
    guardsRoot,
    setPlace,
    setActiveCount,
    noHost,
    connected,
    dispose: () => {
      badge?.dispose()
      empty?.dispose()
    },
  }
}
