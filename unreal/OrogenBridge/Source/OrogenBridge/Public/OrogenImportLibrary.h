// The one function OrogenBridge exposes (export-unreal.md 8.2).
// This source has never been compiled or run: see README.md.

#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"

#include "OrogenImportLibrary.generated.h"

class ALandscape;

UCLASS()
class UOrogenImportLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/**
	 * Creates a Landscape in the current editor world from an Orogen manifest.
	 * MaterialPath: object path of the landscape material, or empty for none.
	 * LayerInfoFolder: content folder for the layer info assets, e.g. "/Game/Orogen/LayerInfos".
	 * Returns the new actor, or nullptr with OutError set. On failure nothing is left in the world.
	 */
	UFUNCTION(BlueprintCallable, Category = "Orogen")
	static ALandscape* ImportTerrain(const FString& ManifestPath, const FString& MaterialPath,
	                                 const FString& LayerInfoFolder, FString& OutError);
};
