import { describe, expect, it } from 'vitest'
import { assemblyPromptTable, parsePcbAssembly } from '../src/parser/pcb-assembly'

describe('PCB assembly parser', () => {
  it('groups pads by footprint and excludes non-assembly objects', () => {
    const pcb = `(kicad_pcb
      (footprint "Package_SO:TSSOP-20" (layer "F.Cu") (at 100 50 90)
        (property "Reference" "U1")
        (property "Value" "AD9834")
        (pad "1" smd rect (at -2 1) (size 1 1) (layers "F.Cu"))
        (pad "2" smd rect (at -2 0) (size 1 1) (layers "F.Cu")))
      (footprint "Connector_Coaxial:SMA" (layer "F.Cu") (at 120 60)
        (property "Reference" "J2") (property "Value" "SYN")
        (pad "1" thru_hole circle (at 0 0) (size 2 2) (layers "*.Cu")))
      (footprint "TestPoint:TestPoint_Pad_D1.0mm" (layer "F.Cu") (at 90 60)
        (property "Reference" "TP1") (property "Value" "TEST")
        (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu")))
      (footprint "MountingHole:MountingHole_3.2mm" (layer "F.Cu") (at 80 40)
        (property "Reference" "H1") (property "Value" "MountingHole")
        (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (layers "*.Cu")))
    )`

    const map = parsePcbAssembly(pcb)
    expect(map.footprints).toHaveLength(4)
    expect(map.inspectable.map((x) => x.ref)).toEqual(['U1', 'J2'])
    expect(map.footprints.find((x) => x.ref === 'U1')?.pads).toHaveLength(2)
    expect(map.footprints.find((x) => x.ref === 'TP1')?.excluded).toBe(true)
    expect(map.footprints.find((x) => x.ref === 'H1')?.excluded).toBe(true)

    const rows = assemblyPromptTable(map, 'front')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.padCount).toBe(2)
    expect(rows[0]?.padNumbers).toEqual(['1', '2'])
  })
})
