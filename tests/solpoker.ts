import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Solpoker } from "../target/types/solpoker";

describe("solpoker", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.solpoker as Program<Solpoker>;

  it("Is initialized!", async () => {
    // Add your test here.
    const tx = await program.methods.initialize().rpc();
    console.log("Your transaction signature", tx);
  });
});
