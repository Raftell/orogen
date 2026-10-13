// Reading and checking a manifest: export-unreal.md 8.3 step 1.
// This source has never been compiled or run: see README.md.
//
// The Core and Json calls here (FJsonSerializer, FJsonObject::TryGet...Field, FFileHelper, IFileManager, FPaths)
// are written as those modules have declared them for many engine versions. The research behind this plugin did
// not re-read them on the 5.8 pages: OPEN QUESTION for the first compile, whether each still has this signature.

#include "OrogenManifest.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "Misc/CString.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
	const TCHAR* const SchemaId = TEXT("orogen.unreal.landscape/1");
	const TCHAR* const ManifestSuffix = TEXT(".orogen.json");

	// The New Landscape panel allows at most 32 x 32 components and Orogen's layouts never exceed it. With the
	// largest section (255 quads, 2 x 2) that bounds a side at 16321 vertices, so SizeX * SizeY * 2 fits an int32.
	constexpr int32 MaxComponentsPerSide = 32;
	constexpr int32 MaxVerticesPerSide = MaxComponentsPerSide * 255 * 2 + 1;

	/** Exact comparison: FString's own operators ignore case. */
	bool IsExactly(const FString& Text, const TCHAR* Expected)
	{
		return FCString::Strcmp(*Text, Expected) == 0;
	}

	bool FieldObject(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, const FJsonObject*& Out, FString& OutError)
	{
		const TSharedPtr<FJsonObject>* Found = nullptr;
		if (!Parent.TryGetObjectField(Field, Found) || Found == nullptr || !Found->IsValid())
		{
			OutError = FString::Printf(TEXT("The manifest has no object \"%s\"."), Shown);
			return false;
		}
		Out = Found->Get();
		return true;
	}

	bool FieldString(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, FString& Out, FString& OutError)
	{
		if (!Parent.TryGetStringField(Field, Out))
		{
			OutError = FString::Printf(TEXT("The manifest has no text \"%s\"."), Shown);
			return false;
		}
		return true;
	}

	/** A member the schema fixes to one value: any other means a manifest this plugin was not written for. */
	bool FieldIs(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, const TCHAR* Expected, FString& OutError)
	{
		FString Value;
		if (!FieldString(Parent, Field, Shown, Value, OutError))
		{
			return false;
		}
		if (!IsExactly(Value, Expected))
		{
			OutError = FString::Printf(TEXT("The manifest's \"%s\" is \"%s\"; this plugin reads only \"%s\"."), Shown, *Value, Expected);
			return false;
		}
		return true;
	}

	bool FieldBool(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, bool& Out, FString& OutError)
	{
		if (!Parent.TryGetBoolField(Field, Out))
		{
			OutError = FString::Printf(TEXT("The manifest has no true or false \"%s\"."), Shown);
			return false;
		}
		return true;
	}

	bool FieldNumber(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, double& Out, FString& OutError)
	{
		double Value = 0.0;
		if (!Parent.TryGetNumberField(Field, Value) || !FMath::IsFinite(Value))
		{
			OutError = FString::Printf(TEXT("The manifest has no number \"%s\"."), Shown);
			return false;
		}
		Out = Value;
		return true;
	}

	bool FieldInt(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, int32 Lowest, int32 Highest, int32& Out, FString& OutError)
	{
		double Value = 0.0;
		if (!FieldNumber(Parent, Field, Shown, Value, OutError))
		{
			return false;
		}
		if (Value != FMath::FloorToDouble(Value) || Value < static_cast<double>(Lowest) || Value > static_cast<double>(Highest))
		{
			OutError = FString::Printf(TEXT("The manifest's \"%s\" is not a whole number from %d to %d."), Shown, Lowest, Highest);
			return false;
		}
		Out = static_cast<int32>(Value);
		return true;
	}

	bool FieldVector(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, FVector& Out, FString& OutError)
	{
		const FJsonObject* Object = nullptr;
		double X = 0.0, Y = 0.0, Z = 0.0;
		if (!FieldObject(Parent, Field, Shown, Object, OutError)
			|| !FieldNumber(*Object, TEXT("x"), Shown, X, OutError)
			|| !FieldNumber(*Object, TEXT("y"), Shown, Y, OutError)
			|| !FieldNumber(*Object, TEXT("z"), Shown, Z, OutError))
		{
			return false;
		}
		Out = FVector(X, Y, Z);
		return true;
	}

	/** A manifest names its files without a directory part. Anything else could point outside the build's folder. */
	bool IsPlainFileName(const FString& Name)
	{
		int32 Unused = INDEX_NONE;
		return !Name.IsEmpty()
			&& !IsExactly(Name, TEXT("."))
			&& !IsExactly(Name, TEXT(".."))
			&& !Name.FindChar(TEXT('/'), Unused)
			&& !Name.FindChar(TEXT('\\'), Unused)
			&& !Name.FindChar(TEXT(':'), Unused);
	}

	bool FieldFile(const FJsonObject& Parent, const TCHAR* Field, const TCHAR* Shown, const FString& Folder, FString& Out, FString& OutError)
	{
		FString Name;
		if (!FieldString(Parent, Field, Shown, Name, OutError))
		{
			return false;
		}
		if (!IsPlainFileName(Name))
		{
			OutError = FString::Printf(TEXT("The manifest's \"%s\" is \"%s\", which is not a file name in the manifest's own folder."), Shown, *Name);
			return false;
		}
		Out = FPaths::Combine(Folder, Name);
		return true;
	}

	/** The pattern of a layer name in the manifest's schema: a letter, then up to 62 letters, digits or underscores. */
	bool IsLayerName(const FString& Name)
	{
		if (Name.Len() < 1 || Name.Len() > 63)
		{
			return false;
		}
		for (int32 Index = 0; Index < Name.Len(); ++Index)
		{
			const TCHAR C = Name[Index];
			const bool bLetter = (C >= TEXT('A') && C <= TEXT('Z')) || (C >= TEXT('a') && C <= TEXT('z'));
			const bool bDigitOrUnderscore = (C >= TEXT('0') && C <= TEXT('9')) || C == TEXT('_');
			if (!bLetter && !(Index > 0 && bDigitOrUnderscore))
			{
				return false;
			}
		}
		return true;
	}

	bool CheckFileSize(const FString& File, int64 Expected, FString& OutError)
	{
		const int64 Size = IFileManager::Get().FileSize(*File);
		if (Size == Expected)
		{
			return true;
		}
		OutError = Size < 0
			? FString::Printf(TEXT("The build's file %s is missing."), *File)
			: FString::Printf(TEXT("The build's file %s holds %lld bytes; the manifest's resolution needs %lld."), *File, Size, Expected);
		return false;
	}

	bool ReadLayer(const FJsonObject& Layer, const FString& Folder, FOrogenManifestLayer& Out, FString& OutError)
	{
		FString Blend;
		if (!FieldString(Layer, TEXT("name"), TEXT("landscape.layers[].name"), Out.Name, OutError)
			|| !FieldString(Layer, TEXT("blend"), TEXT("landscape.layers[].blend"), Blend, OutError))
		{
			return false;
		}
		if (!IsLayerName(Out.Name))
		{
			OutError = FString::Printf(TEXT("The manifest's layer name \"%s\" is not a letter followed by at most 62 letters, digits or underscores."), *Out.Name);
			return false;
		}
		if (IsExactly(Blend, TEXT("none")))
		{
			Out.Blend = EOrogenLayerBlend::None;
		}
		else if (IsExactly(Blend, TEXT("final")))
		{
			Out.Blend = EOrogenLayerBlend::Final;
		}
		else if (IsExactly(Blend, TEXT("advanced")))
		{
			Out.Blend = EOrogenLayerBlend::Advanced;
		}
		else
		{
			OutError = FString::Printf(TEXT("The manifest's layer \"%s\" has the blend \"%s\"; it is \"none\", \"final\" or \"advanced\"."), *Out.Name, *Blend);
			return false;
		}
		return FieldFile(Layer, TEXT("r8"), TEXT("landscape.layers[].r8"), Folder, Out.R8File, OutError);
	}

	bool ReadLandscape(const FJsonObject& Root, const FJsonObject& Landscape, const FString& Folder, FOrogenManifest& Out, FString& OutError)
	{
		// resolution and layout: the layout must give the resolution exactly, so that the engine never pads, crops or resamples.
		const FJsonObject* Resolution = nullptr;
		const FJsonObject* Layout = nullptr;
		const FJsonObject* Components = nullptr;
		if (!FieldObject(Root, TEXT("resolution"), TEXT("resolution"), Resolution, OutError)
			|| !FieldInt(*Resolution, TEXT("x"), TEXT("resolution.x"), 1, MaxVerticesPerSide, Out.SizeX, OutError)
			|| !FieldInt(*Resolution, TEXT("y"), TEXT("resolution.y"), 1, MaxVerticesPerSide, Out.SizeY, OutError)
			|| !FieldObject(Landscape, TEXT("layout"), TEXT("landscape.layout"), Layout, OutError)
			|| !FieldInt(*Layout, TEXT("quadsPerSection"), TEXT("landscape.layout.quadsPerSection"), 7, 255, Out.QuadsPerSection, OutError)
			|| !FieldInt(*Layout, TEXT("sectionsPerComponent"), TEXT("landscape.layout.sectionsPerComponent"), 1, 2, Out.SectionsPerComponent, OutError)
			|| !FieldObject(*Layout, TEXT("components"), TEXT("landscape.layout.components"), Components, OutError)
			|| !FieldInt(*Components, TEXT("x"), TEXT("landscape.layout.components.x"), 1, MaxComponentsPerSide, Out.ComponentsX, OutError)
			|| !FieldInt(*Components, TEXT("y"), TEXT("landscape.layout.components.y"), 1, MaxComponentsPerSide, Out.ComponentsY, OutError))
		{
			return false;
		}
		const int32 Quads = Out.QuadsPerSection;
		if (Quads != 7 && Quads != 15 && Quads != 31 && Quads != 63 && Quads != 127 && Quads != 255)
		{
			OutError = FString::Printf(TEXT("The manifest's \"landscape.layout.quadsPerSection\" is %d; a section has 7, 15, 31, 63, 127 or 255 quads."), Quads);
			return false;
		}
		const int32 LayoutX = Out.ComponentsX * Quads * Out.SectionsPerComponent + 1;
		const int32 LayoutY = Out.ComponentsY * Quads * Out.SectionsPerComponent + 1;
		if (LayoutX != Out.SizeX || LayoutY != Out.SizeY)
		{
			OutError = FString::Printf(TEXT("The manifest's layout gives %d x %d vertices and its resolution is %d x %d."), LayoutX, LayoutY, Out.SizeX, Out.SizeY);
			return false;
		}

		// The heightmap file. The plugin reads the .r16 and never the PNG.
		const FJsonObject* Heightmap = nullptr;
		if (!FieldObject(Landscape, TEXT("heightmap"), TEXT("landscape.heightmap"), Heightmap, OutError)
			|| !FieldFile(*Heightmap, TEXT("r16"), TEXT("landscape.heightmap.r16"), Folder, Out.HeightR16File, OutError))
		{
			return false;
		}

		// The orientation and the layer convention are the only ones this plugin implements.
		const FJsonObject* Orientation = nullptr;
		bool bFlipY = false;
		if (!FieldObject(Landscape, TEXT("orientation"), TEXT("landscape.orientation"), Orientation, OutError)
			|| !FieldIs(*Orientation, TEXT("pixel00"), TEXT("landscape.orientation.pixel00"), TEXT("minX_minY"), OutError)
			|| !FieldIs(*Orientation, TEXT("imageX"), TEXT("landscape.orientation.imageX"), TEXT("+X"), OutError)
			|| !FieldIs(*Orientation, TEXT("imageY"), TEXT("landscape.orientation.imageY"), TEXT("+Y"), OutError)
			|| !FieldBool(*Orientation, TEXT("flipYAxis"), TEXT("landscape.orientation.flipYAxis"), bFlipY, OutError)
			|| !FieldIs(Landscape, TEXT("alphamapType"), TEXT("landscape.alphamapType"), TEXT("Additive"), OutError))
		{
			return false;
		}
		if (bFlipY)
		{
			OutError = TEXT("The manifest's \"landscape.orientation.flipYAxis\" is true; this plugin imports rows as they are stored.");
			return false;
		}

		// The transform.
		const FJsonObject* Transform = nullptr;
		const FJsonObject* Rotation = nullptr;
		double Pitch = 0.0, Yaw = 0.0, Roll = 0.0;
		if (!FieldObject(Landscape, TEXT("transform"), TEXT("landscape.transform"), Transform, OutError)
			|| !FieldVector(*Transform, TEXT("scaleCm"), TEXT("landscape.transform.scaleCm"), Out.ScaleCm, OutError)
			|| !FieldVector(*Transform, TEXT("actorLocationCm"), TEXT("landscape.transform.actorLocationCm"), Out.ActorLocationCm, OutError)
			|| !FieldObject(*Transform, TEXT("rotationDeg"), TEXT("landscape.transform.rotationDeg"), Rotation, OutError)
			|| !FieldNumber(*Rotation, TEXT("pitch"), TEXT("landscape.transform.rotationDeg.pitch"), Pitch, OutError)
			|| !FieldNumber(*Rotation, TEXT("yaw"), TEXT("landscape.transform.rotationDeg.yaw"), Yaw, OutError)
			|| !FieldNumber(*Rotation, TEXT("roll"), TEXT("landscape.transform.rotationDeg.roll"), Roll, OutError))
		{
			return false;
		}
		if (Out.ScaleCm.X <= 0.0 || Out.ScaleCm.Y <= 0.0 || Out.ScaleCm.Z <= 0.0)
		{
			OutError = TEXT("The manifest's \"landscape.transform.scaleCm\" is not above zero on every axis.");
			return false;
		}
		if (Pitch != 0.0 || Yaw != 0.0 || Roll != 0.0)
		{
			OutError = TEXT("The manifest's \"landscape.transform.rotationDeg\" is not zero; this plugin places landscapes unrotated.");
			return false;
		}

		// World Partition.
		const FJsonObject* Partition = nullptr;
		if (!FieldObject(Landscape, TEXT("worldPartition"), TEXT("landscape.worldPartition"), Partition, OutError)
			|| !FieldBool(*Partition, TEXT("enabled"), TEXT("landscape.worldPartition.enabled"), Out.bWorldPartition, OutError)
			|| !FieldInt(*Partition, TEXT("gridSize"), TEXT("landscape.worldPartition.gridSize"), 1, 16, Out.GridSize, OutError))
		{
			return false;
		}

		// The layers.
		const TArray<TSharedPtr<FJsonValue>>* Layers = nullptr;
		if (!Landscape.TryGetArrayField(TEXT("layers"), Layers) || Layers == nullptr)
		{
			OutError = TEXT("The manifest has no list \"landscape.layers\".");
			return false;
		}
		Out.Layers.Reserve(Layers->Num());
		for (const TSharedPtr<FJsonValue>& Value : *Layers)
		{
			const TSharedPtr<FJsonObject>* Layer = nullptr;
			if (!Value.IsValid() || !Value->TryGetObject(Layer) || Layer == nullptr || !Layer->IsValid())
			{
				OutError = TEXT("An entry of the manifest's \"landscape.layers\" is not an object.");
				return false;
			}
			FOrogenManifestLayer Read;
			if (!ReadLayer(**Layer, Folder, Read, OutError))
			{
				return false;
			}
			// Target layer names are case-insensitive in Unreal.
			for (const FOrogenManifestLayer& Earlier : Out.Layers)
			{
				if (FCString::Stricmp(*Earlier.Name, *Read.Name) == 0)
				{
					OutError = FString::Printf(TEXT("The manifest names the layer \"%s\" twice."), *Read.Name);
					return false;
				}
			}
			Out.Layers.Add(MoveTemp(Read));
		}
		return true;
	}
}

bool OrogenLoadManifest(const FString& ManifestPath, FOrogenManifest& OutManifest, FString& OutError)
{
	OutManifest = FOrogenManifest();
	OutError.Reset();

	const FString File = FPaths::ConvertRelativePathToFull(ManifestPath);
	const FString Folder = FPaths::GetPath(File);
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *File))
	{
		OutError = FString::Printf(TEXT("Cannot read the manifest %s."), *File);
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		OutError = FString::Printf(TEXT("%s is not JSON: %s"), *File, *Reader->GetErrorMessage());
		return false;
	}

	// A reader rejects a major version it does not know and ignores members it does not know.
	FString Schema;
	if (!Root->TryGetStringField(TEXT("schema"), Schema) || !IsExactly(Schema, SchemaId))
	{
		OutError = FString::Printf(TEXT("%s is not a manifest this plugin reads: its schema is \"%s\" and the plugin reads \"%s\"."), *File, *Schema, SchemaId);
		return false;
	}
	if (!FieldIs(*Root, TEXT("status"), TEXT("status"), TEXT("complete"), OutError))
	{
		return false;
	}

	// A build of textures or images only has `"landscape": null`, which is no object.
	const TSharedPtr<FJsonObject>* Landscape = nullptr;
	if (!Root->TryGetObjectField(TEXT("landscape"), Landscape) || Landscape == nullptr || !Landscape->IsValid())
	{
		OutError = FString::Printf(TEXT("The build of %s holds no landscape: its graph has no Unreal Landscape node."), *File);
		return false;
	}
	if (!ReadLandscape(*Root, **Landscape, Folder, OutManifest, OutError))
	{
		return false;
	}

	// The data files must hold exactly the samples the resolution needs: a raw file has no header to say otherwise.
	const int64 Samples = static_cast<int64>(OutManifest.SizeX) * static_cast<int64>(OutManifest.SizeY);
	if (!CheckFileSize(OutManifest.HeightR16File, Samples * 2, OutError))
	{
		return false;
	}
	for (const FOrogenManifestLayer& Layer : OutManifest.Layers)
	{
		if (!CheckFileSize(Layer.R8File, Samples, OutError))
		{
			return false;
		}
	}

	const FString FileName = FPaths::GetCleanFilename(File);
	const int32 SuffixLength = FCString::Strlen(ManifestSuffix);
	OutManifest.Name = FileName.EndsWith(ManifestSuffix, ESearchCase::IgnoreCase)
		? FileName.LeftChop(SuffixLength)
		: FPaths::GetBaseFilename(FileName);
	return true;
}
