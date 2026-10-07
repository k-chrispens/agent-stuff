# /// script
# dependencies = ["gemmi", "PeptideBuilder"]
# ///
"""Synthetic example: a helix whose Lys4 side chain has two conformers.

Writes single.cif (conformer A only), ensemble.cif (A and B at 0.5 occupancy)
and map.ccp4 (density calculated from the ensemble), all in one P1 cell.
"""
import io
from pathlib import Path

import gemmi
import PeptideBuilder
from Bio.PDB import PDBIO
from PeptideBuilder import Geometry

OUT = Path(__file__).parent
SIDE_CHAIN = {"CG", "CD", "CE", "NZ"}
CELL = 30.0


def helix(lys_chi1):
    geometries = []
    for i, aa in enumerate("AAAKAAAA"):
        g = Geometry.geometry(aa)
        g.phi, g.psi_im1 = -57, -47
        if aa == "K":
            g.N_CA_CB_CG_diangle = lys_chi1
        geometries.append(g)
    chain = PeptideBuilder.initialize_res(geometries[0])
    for g in geometries[1:]:
        PeptideBuilder.add_residue(chain, g)
    pdb = io.StringIO()
    writer = PDBIO()
    writer.set_structure(chain)
    writer.save(pdb)
    return gemmi.read_pdb_string(pdb.getvalue())


def finish(structure, shift):
    structure.cell = gemmi.UnitCell(CELL, CELL, CELL, 90, 90, 90)
    structure.spacegroup_hm = "P 1"
    for cra in structure[0].all():
        cra.atom.pos = cra.atom.pos + shift
        cra.atom.b_iso = 20
    structure.setup_entities()
    return structure


single, other = helix(-60), helix(180)
ensemble = single.clone()
lys, lys_other = ensemble[0][0][3], other[0][0][3]
for atom in lys:
    if atom.name in SIDE_CHAIN:
        atom.altloc, atom.occ = "A", 0.5
for atom in lys_other:
    if atom.name in SIDE_CHAIN:
        atom.altloc, atom.occ = "B", 0.5
        lys.add_atom(atom)

box = ensemble.calculate_box()
center = [(box.minimum[i] + box.maximum[i]) / 2 for i in range(3)]
shift = gemmi.Position(*(CELL / 2 - c for c in center))
for name, structure in (("single", single), ("ensemble", ensemble)):
    finish(structure, shift).make_mmcif_document().write_file(str(OUT / f"{name}.cif"))

calculator = gemmi.DensityCalculatorX()
calculator.d_min, calculator.rate = 2.0, 1.2
calculator.grid.setup_from(ensemble)
calculator.put_model_density_on_grid(ensemble[0])
density = gemmi.Ccp4Map()
density.grid = calculator.grid
density.update_ccp4_header()
density.write_ccp4_map(str(OUT / "map.ccp4"))
print(f"wrote single.cif, ensemble.cif, map.ccp4 ({calculator.grid.nu}^3 grid)")
